'use strict'

const fs = require("fs");
const uuid = require('uuid').v4;
const streamBuffers = require("stream-buffers");
const grpc = require("grpc");
const VAD = require("../nodejs_vad/vad");
const { healthChecker } = require("./health-check");
const metrics = require('../grafana/metrics');
const EventEmitter = require('events');

const _main_path = __dirname + "/../";

const serverconf = JSON.parse(fs.readFileSync(_main_path + "config/config_server.json"));
const langconf = JSON.parse(fs.readFileSync(_main_path + "config/config_languages.json"));
const denoiserconf = JSON.parse(fs.readFileSync(_main_path + "config/config_denoise.json"));
const asrconf = JSON.parse(fs.readFileSync(_main_path + "config/config_asr.json"));
const vadASRconf = JSON.parse(fs.readFileSync(_main_path + "config/config_vad_ASR.json"));
const nlpconf = JSON.parse(fs.readFileSync(_main_path + "config/config_nlp.json"));
const saveconf = JSON.parse(fs.readFileSync(_main_path + "config/config_saves3_ASR.json"));

const myArgs = process.argv.slice(2);
const newPort = parseInt(myArgs[0])
if (newPort) serverconf.server_asr.port = newPort

const langList = Object.keys(langconf.language_dict);


const prettier = (obj) => {
    return JSON.stringify(obj, null, 1);
};


const constParams = {
    frame_len: denoiserconf.frame_len,
    denoiseLen: denoiserconf.frame_len * 2,
    denoisePad: denoiserconf.pad * 2,
    min_speech: Math.round(vadASRconf.min_speech * vadASRconf.fs / 1000) * 2,
    pack_time: asrconf.periodic_package_ms,
    max_req_wait: asrconf.max_req_wait * 1000,
    vadChunkMs: vadASRconf.frame_ms,
    vadChunkSize: Math.round(vadASRconf.frame_ms * 2 * vadASRconf.fs / 1000),
    nclasses: denoiserconf.nclasses,
    speech_offset: denoiserconf.speech_offset,
    min_rms: denoiserconf.min_rms,
    save_audio: saveconf.save_audio,
    beam_size: asrconf.beam_size,
    min_beam_size: asrconf.min_beam_size,
    max_beam_size: asrconf.max_beam_size
}


class StreamObjectCl {
    constructor(logger, loggerS3, loggerAsr, stream, nlpDict) {
        this.logger = logger;
        this.loggerS3 = loggerS3;
        this.loggerAsr = loggerAsr;
        this.stream = stream;
        this.nlpDict = nlpDict;
        // UID / RID
        const unique_id = uuid()
        this.uid = `unkUID-${unique_id}`;
        this.rid = `unkRID-${unique_id}`;
        // Language
        this.language = undefined;
        this.index_lan = undefined;
        this.lan_dict = undefined;
        this.lan_dict_len = undefined;
        // Denoiser
        this.use_denoising = false;
        this.save_type = 'original';
        // VAD
        this.vad = undefined;
        // NLP
        this.use_nlp = 'NONE';
        this.nlp_num = 0;
        // ASR
        this.asr_model_partial = 'bert-lm';
        this.asr_model_final = 'bert-lm';
        this.use_gpu = false;
        this.online = false;
        // Other variables
        this.stop = false;
        this.alreadyEnded = false;
        this.vad_out = null;
        this.processing_asr = false;
        this.is_first = true;
        this.zero_req_available = false;
        // Denoiser
        this.cleanBefore = new Float32Array(constParams.denoisePad).fill(0);
        this.cvector = new Float32Array(Array(denoiserconf.nclasses).fill(-1), 0);
        this.noisyBufferFrame = Buffer.from([]);
        this.noisyBuffer = new streamBuffers.WritableStreamBuffer({
            initialSize: 100 * 1024, // start at 100 kilobytes.
            incrementAmount: 10 * 1024, // grow by 10 kilobytes each time buffer overflows.
        });
        this.cleanMemo = new streamBuffers.WritableStreamBuffer({
            initialSize: 100 * 1024, // start at 100 kilobytes.
            incrementAmount: 10 * 1024, // grow by 10 kilobytes each time buffer overflows.
        });
        // Timers
        this.last_resp_time = Date.now();
        this.last_requ_time = Date.now();
        // Periodic
        this.periodicFns = [];
        // Setup
        this.setupDone = false;
        // Sentences
        this.currSentenceId = uuid();
        this.frame_list = {};
        this.frame_list[this.currSentenceId] = {
            started: false,
            lastLength: 2,
            is_final: false,
            is_final_processed: false,
            speechBufferFull: Buffer.from(new Int16Array([0]).buffer),
            speechBufferFrame: Buffer.from(new Int16Array([0]).buffer)
        };
        this.metricDecDone = true;
    }
    _setLanguage(data) {
        return new Promise((resolve, reject) => {
            const lang_req = data.streaming_config.config.language_code;
            if (langList.indexOf(lang_req) >= 0) {
                this.language = langconf.language_dict[lang_req];
                return resolve();
            } else {
                this.stream.status.code = grpc.status.INVALID_ARGUMENT;
                this.stream.status.details = `Language ${lang_req} is not valid.`;
                this.stream.end();
                return reject(`Language ${lang_req} is not valid.`);
            };
        });
    }
    _checkCalls() {
        return new Promise(async(resolve, reject) => {
            try {
                const concReq = await metrics.concurrentRequests.get();
                const nCalls = concReq.values.length > 0 ? concReq.values[0].value : 0;
                if (nCalls >= serverconf.server_asr.num_workers) {
                    this.stream.status.code = grpc.status.RESOURCE_EXHAUSTED;
                    this.stream.status.details = 'Call limit reached in this Integrator.';
                    this.stream.end()
                    return reject('Call limit reached in this Integrator.');
                } else {
                    return resolve();
                }
            } catch(err) {
                return reject(`ERROR checking number of current calls -> ${err}`);
            }
        })
    }
    cleanObj() {
        if (this.periodicFns.length > 0) {
            this.periodicFns.map(periodicFn => clearInterval(periodicFn));
        };
        this.noisyBuffer.end();
        this.cleanMemo.end();
    }
    resetSpeechFull(sentenceId) {
        this.frame_list[sentenceId].speechBufferFull = Buffer.from(new Int16Array([0]).buffer);
    }
    addSpeechFull (sentenceId, chunk) {
        this.frame_list[sentenceId].speechBufferFull = Buffer.concat([this.frame_list[sentenceId].speechBufferFull, chunk]);
    }
    getSpeechFull (sentenceId) {
        return this.frame_list[sentenceId].speechBufferFull;
    }
    resetSpeechFrame (sentenceId) {
        this.frame_list[sentenceId].speechBufferFrame = Buffer.from(new Int16Array([0]).buffer);
        // this.is_first = true;
    }
    addSpeechFrame (sentenceId, chunk) {
        this.frame_list[sentenceId].speechBufferFrame = Buffer.concat([this.frame_list[sentenceId].speechBufferFrame, chunk]);
    }
    getSpeechFrame (sentenceId) {
        return this.frame_list[sentenceId].speechBufferFrame;
    }
    updateLastReqTime () {
        this.last_requ_time = Date.now()
    }
    updateLastRespTime () {
        this.last_resp_time = Date.now()
    }
    newSentence () {
        this.frame_list[this.currSentenceId].is_final = true;
        this.currSentenceId = uuid()
        this.frame_list[this.currSentenceId] = {
            started: false,
            lastLength: 2,
            is_final: false,
            is_final_processed: false,
            speechBufferFull: Buffer.from(new Int16Array([0]).buffer),
            speechBufferFrame: Buffer.from(new Int16Array([0]).buffer)
        }
    }
    updateSentence (chunk) {
        this.frame_list[this.currSentenceId].speechBufferFull = Buffer.concat([this.frame_list[this.currSentenceId].speechBufferFull, chunk]);
        this.frame_list[this.currSentenceId].speechBufferFrame = Buffer.concat([this.frame_list[this.currSentenceId].speechBufferFrame, chunk]);
    }
    removeSentence (sentenceId) {
        delete this.frame_list[sentenceId];
    }
    checkIfAnySentence() {
        return Object.keys(this.frame_list).length > 1;
    }
    sentenceStarted() {
        const started = this.frame_list[this.currSentenceId].started;
        this.frame_list[this.currSentenceId].started = true;
        return started;
    }
    sentenceHasChanged(sentenceId) {
        const newLength = this.frame_list[sentenceId].speechBufferFrame.length;
        const hasChanged = this.frame_list[sentenceId].lastLength != newLength;
        this.frame_list[sentenceId].lastLength = newLength;
        return hasChanged
    }
    sentenceIsFinal(sentenceId) {
        return this.frame_list[sentenceId].is_final;
    }
    setIsFinalDone(sentenceId) {
        const is_final = this.frame_list[sentenceId].is_final;
        this.frame_list[sentenceId].is_final_processed = is_final;
        return is_final;
    }
    getIsFinalDone(sentenceId) {
        return this.frame_list[sentenceId].is_final_processed;
    }
    getSentenceLenMs(sentenceId) {
        return this.frame_list[sentenceId].lastLength * 1000 / (vadASRconf.fs * 2);
    }
    getModel(is_final) {
        return is_final ? this.asr_model_final : this.asr_model_partial;
    }
    update(data) {
        this.setupDone = true;
        return new Promise(async(resolve, reject) => {
            try {
                const activeDenoise = data.streaming_config.config.use_enhanced && denoiserconf.enable_denoise;
                const use_nlp = data.streaming_config.config.use_nlp !== 'NONE' && nlpconf.enable_nlp ? data.streaming_config.config.use_nlp : 'NONE';
                const dedicated_nlp = use_nlp !== 'NONE' && use_nlp !== 'GENERAL' && use_nlp !== 'NUMBER_MENU' && use_nlp !== 'NUMBER' && use_nlp !== 'DIGIT' && use_nlp !== 'CONFIRMATION';
                // this.online = data.streaming_config.config.use_provisional_transcription && (use_nlp === 'NONE' || use_nlp === 'GENERAL');
                this.online = data.streaming_config.config.use_provisional_transcription && (use_nlp === 'NONE' || use_nlp === 'GENERAL') && !["ar-AE"].includes(data.streaming_config.config.language_code); // ÑAPA PARA EXCLUIR EL ARABE

                this.uid = this.stream.metadata._internal_repr.uid ? this.stream.metadata._internal_repr.uid[0] : this.uid;
                this.rid = this.stream.metadata._internal_repr.request_id ? this.stream.metadata._internal_repr.request_id[0] : this.rid;
                try {
                    await this._setLanguage(data); // Check & Set language
                    await this._checkCalls(); // Check & Set calls
                } catch (err) {
                    return reject(err);
                }
                // Metrics
                metrics.concurrentRequests.inc({ asr: this.language });
                this.metricDecDone = false;
                metrics.counterTotalRequests.inc({ asr: this.language });
                // Denoiser
                this.use_denoising = activeDenoise ? true : false;
                this.save_type = activeDenoise ? 'denoised' : 'original';
                // VAD
                this.vad = new VAD(activeDenoise, dedicated_nlp, use_nlp==='CONFIRMATION');
                // NLP
                this.use_nlp = use_nlp;
                this.nlp_num = this.nlpDict[use_nlp];
                // Health Check
                healthChecker(this.language, use_nlp !== 'NONE' && use_nlp !== 'GENERAL', this.online).then(() => {
                    this.logger.info(`UID:${this.uid} RID:${this.rid} - Lang:${this.language}|Denoise:${this.use_denoising}|NLP:${this.use_nlp}|Transformer:${this.use_gpu}|Online:${this.online} - STREAM STARTED.`);
                    return resolve()
                }).catch((err) => {
                    this.stream.status.code = grpc.status.UNAVAILABLE;
                    this.stream.status.details = err;
                    this.stream.end();
                    return reject(err);
                })
            } catch (err) {
                return reject(`"streamObj.update" initialization ERROR -> ${err}`);
            }
        })
    }
}

module.exports = {
    prettier,
    constParams,
    StreamObjectCl,
}
