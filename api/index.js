const requestHandler = require('../server.js');

module.exports = (req, res) => {
    return requestHandler(req, res);
};
