'use strict'

const metrics = require('../grafana/metrics');
const { processDenoise } = require("../nodejs_denoise/denoise");
const { processLooper } = require("../nodejs_looper/looper");


const streamRun = (constParams, streamObj, data) => new Promise(async(resolve, reject) => {
    // GET DATA and DENOISE
    try {
        if (data.audio_content.length && !streamObj.alreadyEnded) {
            streamObj.updateLastReqTime();
            streamObj.zero_req_available = true;
            if(streamObj.use_denoising) await processDenoise(constParams, streamObj, data.audio_content);
            else await processLooper(constParams, streamObj, [data.audio_content, null]);
        } else if (!streamObj.stop && !streamObj.setupDone) await streamObj.update(data);
        return resolve();
    } catch(err) {
        return reject(`"streamRun" ERROR -> ${err}`);
    }
})


const streamEnd = (streamObj) => {
    if (!streamObj.alreadyEnded) {
        streamObj.alreadyEnded = true;
        streamObj.stream.end();
    }
    if (!streamObj.metricDecDone) {
        streamObj.metricDecDone = true;
        metrics.concurrentRequests.dec({ asr: streamObj.language });
    }
    streamObj.cleanObj();
    streamObj.logger.info(`UID:${streamObj.uid} RID:${streamObj.rid} - STREAM STOPPED`);
    return;
}


module.exports = {
    streamRun,
    streamEnd,
};