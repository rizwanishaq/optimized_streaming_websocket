'use strict'

const grpc = require("grpc");
const metrics = require('../grafana/metrics');


const streamError = (streamObj, err) => {
    streamObj.stream.status.code = grpc.status.INTERNAL;
    streamObj.stream.status.details = err;
    streamObj.stream.end();
    metrics.counterErroredRequests.inc({ asr: streamObj.language, code: err.code ? err.code : 500 });
    if (err) streamObj.logger.error(`UID:${streamObj.uid} RID:${streamObj.rid} - STREAM ERROR -> ${err}`);
    else streamObj.logger.info(`UID:${streamObj.uid} RID:${streamObj.rid} - STREAM ERROR`);
    return;
}


module.exports = {
    streamError,
};