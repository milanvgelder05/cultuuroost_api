// netlify/functions/api.js
const serverless = require('serverless-http');
const app = require('../../app'); // Adjust the path if your app.js is located elsewhere

module.exports.handler = serverless(app);
