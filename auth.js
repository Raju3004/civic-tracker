const jwt = require('jsonwebtoken');

// Local demo secret — fine for a college submission; use an env var if this ever goes to production
const JWT_SECRET = 'civictrack-local-demo-secret';

// In-memory revocation list for logout — resets on server restart, which is a known
// limitation of this simple approach (fine for a local demo, not production-grade)
const revokedTokens = new Set();
function revokeToken(token) {
  revokedTokens.add(token);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
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
    req.user = jwt.verify(token, JWT_SECRET);
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

// Strict-ish RFC 5322 / HTML5-spec style email pattern
const EMAIL_REGEX = /^[a-zA-Z][a-zA-Z0-9._%+-]*@(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|icloud\.com|rediffmail\.com)$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim().toLowerCase());
}
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const REPEATED_DIGIT_REGEX = /^(\d)\1{9}$/;

function isValidMobile(mobile) {
  if (typeof mobile !== 'string') return false;
  const trimmed = mobile.trim();
  if (!MOBILE_REGEX.test(trimmed)) return false;
  if (REPEATED_DIGIT_REGEX.test(trimmed)) return false;
  return true;
}
module.exports = { signToken, authenticate, requireRole, isValidEmail, isValidMobile, revokeToken };