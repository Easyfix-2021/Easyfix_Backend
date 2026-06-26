const logger = require('../logger');
const { modernError, legacyError } = require('../utils/response');

function isIntegrationRoute(req) {
  return req.originalUrl.startsWith('/api/integration/');
}

function notFound(req, res) {
  // Distinguish an UNMATCHED ROUTE (Express fell through to here) from a
  // handler's resource-404. The message names the method so the log + the
  // client response say "no route", not a bare "Not Found" — e.g. a 404 on a
  // newly-added route usually means the server wasn't restarted.
  const msg = `No matching route for ${req.method} (check the method/path, and that the server is up to date)`;
  if (isIntegrationRoute(req)) {
    return legacyError(res, 404, msg);
  }
  return modernError(res, 404, msg);
}

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  logger.error(
    {
      err: { message: err.message, stack: err.stack, code: err.code },
      url: req.originalUrl,
      method: req.method,
    },
    'request error'
  );

  if (isIntegrationRoute(req)) {
    return legacyError(res, status, status >= 500 ? 'Internal Server Error' : err.message);
  }

  const body = {
    success: false,
    error: status >= 500 ? 'Internal Server Error' : err.message,
  };
  if (err.details) body.details = err.details;
  return res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
