'use strict'

const { processDenoise } = require("../nodejs_denoise/denoise");
const { processLooper } = require("../nodejs_looper/looper");

const periodicZeroRequestFn = (constParams, streamObj) => {
    if (streamObj.zero_req_available && constParams.max_req_wait <= (Date.now() - streamObj.last_requ_time) && !streamObj.alreadyEnded){
        streamObj.zero_req_available = false
        const n = Math.floor(constParams.onlineStep / constParams.vadChunkSize)
        for (let i=0;i<n;i++) {
            setTimeout(async() => {
                const chunk = constParams.final_noise.slice(i*constParams.vadChunkSize, (i+1)*constParams.vadChunkSize);
                if(streamObj.use_denoising) await processDenoise(constParams, streamObj, chunk);
                else await processLooper(constParams, streamObj, [chunk, null]);
            }, i*constParams.vadChunkMs)  // Necesario porque sino se queda atascado en el denoise
        }
        streamObj.logger.warn(`UID:${streamObj.uid} RID:${streamObj.rid} - ZERO FINAL used.`);
        streamObj.updateLastReqTime()
    }
}

const periodicResponseFn = (constParams, streamObj) => {
    if (constParams.pack_time <= (Date.now() - streamObj.last_resp_time)) {
        streamObj.last_resp_time += constParams.pack_time
        if (!streamObj.alreadyEnded) {
            streamObj.stream.write({
                results: [{
                    alternatives: [{transcript: ''}],
                    audioclass: {
                        speech: streamObj.cvector[0],
                        noise: streamObj.cvector[1],
                        music: streamObj.cvector[2]
                    },
                    is_final: false
                }], 
                processing_speech: streamObj.processing_asr
            })
        }
    }
}

module.exports = {
    periodicZeroRequestFn,
    periodicResponseFn,
};