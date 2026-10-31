const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// The signing secret comes from the JWT_SECRET environment variable (server.js refuses to start without it).
// Read lazily so tests can set it before the first token is signed.
const MIN_SECRET_LENGTH = 32;
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

// In-memory revocation list for logout — resets on server restart, which is a known
// limitation of this simple approach (fine for a local demo, not production-grade)
const revokedTokens = new Set();
function revokeToken(token) {
  revokedTokens.add(token);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    getSecret(),
    // jwtid makes every token unique, so logging out one session never revokes another
    // that was issued in the same second with the same payload
    { expiresIn: '7d', jwtid: crypto.randomUUID() }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  const token = header.split(' ')[1];
  if (revokedTokens.has(token)) {
    return res.status(401).json({ error: 'You have been logged out. Please log in again.' });
  }
  try {
    req.user = jwt.verify(token, getSecret());
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

const ROLE_PLURAL = { citizen: 'citizens', authority: 'authorities' };

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Only ${ROLE_PLURAL[role] || role + 's'} can do this.` });
    }
    next();
  };
}

// Email/mobile/password rules now live in shared/rules.js (shared with the frontend)
module.exports = { MIN_SECRET_LENGTH, signToken, authenticate, requireRole, revokeToken };