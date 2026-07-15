import crypto from 'crypto';

// HTTP Basic auth gate. Fail-closed: if READER_PASSWORD is not set, every
// request gets a 503 — the app never runs unprotected.
export function basicAuth(req, res, next) {
  const password = process.env.READER_PASSWORD;

  if (!password) {
    return res.status(503).send('Service unavailable: READER_PASSWORD is not configured');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    // Username is ignored; only the password (everything after the first colon) matters
    const supplied = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(supplied);
    const b = Buffer.from(password);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="RSS Reader", charset="UTF-8"');
  res.status(401).send('Authentication required');
}
