'use strict'

const { nlpClient } = require("../nodejs_nlp/client/user_class");

const healthChecker = (lang, dedicated_nlp, activateOnline) => new Promise((resolve, reject) => {
    Promise.all([
        dedicated_nlp ? nlpClient({type: "STATUS", language: lang}) : undefined,
    ])
    .then(() => resolve())
    .catch((err) => reject(`[HEALTH CHECK] ${err}`));
})


module.exports = {
    healthChecker,
};