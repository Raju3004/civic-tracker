/*
 * CivicTrack validation rules — single source of truth.
 *
 * This one file is used by BOTH sides:
 *   - backend:  require('./shared/rules')
 *   - frontend: <script src="/shared/rules.js"> (Express serves /shared statically)
 * so constants and messages can never drift apart.
 *
 * Every validate* function returns an error message string, or '' when the value is fine.
 * The validate*Form functions return { fieldName: message } (empty object = valid),
 * which is exactly the shape the API sends back as { errors: {...} }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CivicRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NAME = { min: 2, max: 50 };
  const EMAIL = { max: 254 };
  const PASSWORD = { min: 8, max: 64 };
  // Substrings shorter than this are not checked against the password ("jo" in "Jo$eph1234" would be absurd)
  const PERSONAL_PART_MIN = 3;
  const TITLE = { min: 5, max: 100 };
  const DESCRIPTION = { min: 20, max: 1000 };
  const ADDRESS = { max: 200 };
  const REMARK = { min: 10, max: 500 };
  const SEARCH = { max: 100 };

  const ROLES = ['citizen', 'authority'];
  const CATEGORIES = ['Pothole', 'Garbage', 'Streetlight', 'Water Supply', 'Other'];
  const AUTO_CATEGORY = 'Auto-detect';
  const STATUSES = ['Pending', 'In Progress', 'Resolved', 'Rejected'];
  // Allowed status moves. Resolved and Rejected are final.
  const STATUS_TRANSITIONS = {
    Pending: ['In Progress', 'Rejected'],
    'In Progress': ['Resolved', 'Rejected'],
    Resolved: [],
    Rejected: [],
  };
  const REMARK_REQUIRED_FOR = ['Resolved', 'Rejected'];

  // Signup only accepts these providers (kept from the original app); login only checks the format
  const ALLOWED_EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'rediffmail.com'];

  const IMAGE = {
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 5,
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  };

  const EMAIL_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
  const NAME_CHARS = /^[\p{L} .'-]+$/u;
  const MOBILE_FORMAT = /^(\+91)?[6-9]\d{9}$/;
  const REPEATED_DIGITS = /^(\d)\1{9}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ---------- Normalisers ----------

  // Remove HTML tags/comments (and the contents of <script>/<style>) and control characters.
  // Used by the backend on every free-text input; the frontend also escapes on output.
  function stripHtml(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    let previous;
    do {
      previous = out;
      out = out
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-zA-Z!?][^>]*>?/g, '');
    } while (out !== previous);
    // eslint-disable-next-line no-control-regex
    return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }
  const clean = value => (typeof value === 'string' ? stripHtml(value).trim() : '');
  const normalizeName = value => clean(value);
  const normalizeEmail = value => clean(value).toLowerCase();
  const normalizeMobile = value => clean(value).replace(/^\+91/, '');

  // ---------- Field validators (return '' when valid) ----------

  function validateName(value) {
    const v = normalizeName(value);
    if (!v) return 'Full name is required.';
    if (v.length < NAME.min) return `Name must be at least ${NAME.min} characters.`;
    if (v.length > NAME.max) return `Name must be at most ${NAME.max} characters.`;
    if (!NAME_CHARS.test(v) || !/\p{L}/u.test(v)) {
      return "Name can only contain letters, spaces, dots, apostrophes and hyphens.";
    }
    if (/ {2}/.test(v)) return 'Name cannot contain double spaces.';
    return '';
  }

  function validateEmail(value, { restrictDomain = false } = {}) {
    const v = normalizeEmail(value);
    if (!v) return 'Email is required.';
    if (v.length > EMAIL.max) return `Email must be at most ${EMAIL.max} characters.`;
    if (/\s/.test(typeof value === 'string' ? value.trim() : '')) return 'Email cannot contain spaces.';
    if (v.includes('..')) return 'Email cannot contain consecutive dots.';
    if (!EMAIL_FORMAT.test(v) || v.split('@').length !== 2 || v.split('@')[0].endsWith('.')) {
      return 'Enter a valid email address, like name@example.com.';
    }
    if (restrictDomain && !ALLOWED_EMAIL_DOMAINS.includes(v.split('@')[1])) {
      return `Use an email from ${ALLOWED_EMAIL_DOMAINS.join(', ')}.`;
    }
    return '';
  }

  function validateMobile(value) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) return 'Mobile number is required.';
    if (!MOBILE_FORMAT.test(v)) return 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9 (optional +91).';
    if (REPEATED_DIGITS.test(normalizeMobile(v))) return 'Enter a real mobile number, not one repeated digit.';
    return '';
  }

  // Pieces of the user's identity the password must not contain
  function personalParts({ name, email } = {}) {
    const parts = new Set();
    const n = normalizeName(name).toLowerCase();
    if (n.replace(/\s/g, '').length >= PERSONAL_PART_MIN) parts.add(n.replace(/\s/g, ''));
    n.split(/[\s.'-]+/).forEach(t => t.length >= PERSONAL_PART_MIN && parts.add(t));
    const local = normalizeEmail(email).split('@')[0] || '';
    if (local.length >= PERSONAL_PART_MIN) parts.add(local);
    return [...parts];
  }

  // The checklist the signup form ticks off live. `ok` is true only when the rule is met.
  function passwordChecks(password, ctx) {
    const p = typeof password === 'string' ? password : '';
    const lower = p.toLowerCase();
    const parts = personalParts(ctx);
    return [
      { id: 'length', label: `${PASSWORD.min}–${PASSWORD.max} characters`, ok: p.length >= PASSWORD.min && p.length <= PASSWORD.max },
      { id: 'upper', label: 'One uppercase letter', ok: /[A-Z]/.test(p) },
      { id: 'lower', label: 'One lowercase letter', ok: /[a-z]/.test(p) },
      { id: 'number', label: 'One number', ok: /\d/.test(p) },
      { id: 'symbol', label: 'One symbol (like ! @ # $)', ok: /[^A-Za-z0-9\s]/.test(p) },
      { id: 'spaces', label: 'No spaces', ok: p.length > 0 && !/\s/.test(p) },
      {
        id: 'personal',
        label: 'Does not contain your name or email',
        ok: p.length > 0 && !parts.some(part => lower.includes(part)),
      },
    ];
  }

  function validatePassword(value, ctx) {
    if (typeof value !== 'string' || !value) return 'Password is required.';
    if (value.length < PASSWORD.min) return `Password must be at least ${PASSWORD.min} characters.`;
    if (value.length > PASSWORD.max) return `Password must be at most ${PASSWORD.max} characters.`;
    if (/\s/.test(value)) return 'Password cannot contain spaces.';
    if (!/[A-Z]/.test(value)) return 'Password needs at least one uppercase letter.';
    if (!/[a-z]/.test(value)) return 'Password needs at least one lowercase letter.';
    if (!/\d/.test(value)) return 'Password needs at least one number.';
    if (!/[^A-Za-z0-9\s]/.test(value)) return 'Password needs at least one symbol.';
    const failed = passwordChecks(value, ctx).find(c => c.id === 'personal' && !c.ok);
    if (failed) return 'Password must not contain your name or the first part of your email.';
    return '';
  }

  // 0–4 score for the strength meter: weak (<=2), fair (3), strong (4)
  function passwordStrength(password, ctx) {
    const p = typeof password === 'string' ? password : '';
    if (!p) return { score: 0, label: '' };
    const checks = passwordChecks(p, ctx);
    const met = checks.filter(c => c.ok).length;
    let score = 0;
    if (met >= 3) score = 1;
    if (met >= 6) score = 2;
    if (met === checks.length) score = 3;
    if (met === checks.length && p.length >= 12) score = 4;
    const label = score <= 1 ? 'Weak' : score === 2 ? 'Fair' : 'Strong';
    return { score, label };
  }

  function validateConfirmPassword(confirm, password) {
    if (typeof confirm !== 'string' || !confirm) return 'Please confirm your password.';
    if (confirm !== password) return 'Passwords do not match.';
    return '';
  }

  function validateRole(value) {
    return ROLES.includes(value) ? '' : 'Choose citizen or authority.';
  }

  function validateTitle(value) {
    const v = clean(value);
    if (!v) return 'Title is required.';
    if (v.length < TITLE.min) return `Title must be at least ${TITLE.min} characters.`;
    if (v.length > TITLE.max) return `Title must be at most ${TITLE.max} characters.`;
    return '';
  }

  function validateDescription(value) {
    const v = clean(value);
    if (!v) return 'Description is required.';
    if (v.length < DESCRIPTION.min) return `Description must be at least ${DESCRIPTION.min} characters.`;
    if (v.length > DESCRIPTION.max) return `Description must be at most ${DESCRIPTION.max} characters.`;
    return '';
  }

  function validateCategory(value) {
    // empty / Auto-detect means "let the classifier decide"
    if (value === undefined || value === null || value === '' || value === AUTO_CATEGORY) return '';
    return CATEGORIES.includes(value) ? '' : `Category must be one of: ${CATEGORIES.join(', ')}.`;
  }

  const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    return NaN;
  }

  function validateLat(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n) || n < -90 || n > 90) return 'Latitude must be a number between -90 and 90.';
    return '';
  }
  function validateLng(value) {
    const n = toNumber(value);
    if (!Number.isFinite(n) || n < -180 || n > 180) return 'Longitude must be a number between -180 and 180.';
    return '';
  }

  function validateAddress(value) {
    if (isBlank(value)) return '';
    if (clean(value).length > ADDRESS.max) return `Address must be at most ${ADDRESS.max} characters.`;
    return '';
  }

  function validateRemark(value, { required } = {}) {
    const v = clean(value);
    if (!v) return required ? `A remark of ${REMARK.min}–${REMARK.max} characters is required.` : '';
    if (v.length < REMARK.min) return `Remark must be at least ${REMARK.min} characters.`;
    if (v.length > REMARK.max) return `Remark must be at most ${REMARK.max} characters.`;
    return '';
  }

  function validateSearch(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return 'Search must be text.';
    if (value.trim().length > SEARCH.max) return `Search must be at most ${SEARCH.max} characters.`;
    return '';
  }

  function validateStatusTransition(from, to) {
    if (!STATUSES.includes(to)) return `Status must be one of: ${STATUSES.join(', ')}.`;
    if (!STATUS_TRANSITIONS[from]) return `Unknown current status "${from}".`;
    if (!STATUS_TRANSITIONS[from].includes(to)) {
      const next = STATUS_TRANSITIONS[from];
      return next.length
        ? `A ${from} complaint can only move to: ${next.join(' or ')}.`
        : `A ${from} complaint is final and cannot be changed.`;
    }
    return '';
  }

  // Filter-bar helpers: what the allowed next statuses are for a complaint
  const nextStatuses = from => STATUS_TRANSITIONS[from] || [];

  // ---------- Image content checks (first bytes, not the extension) ----------

  // Returns 'jpeg' | 'png' | 'webp' | null from a Buffer / Uint8Array
  function sniffImageType(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((b, i) => bytes[i] === b)) return 'png';
    const ascii = (start, text) => [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
    return null;
  }

  function fileExtension(filename) {
    const m = /\.([A-Za-z0-9]+)$/.exec(typeof filename === 'string' ? filename : '');
    return m ? m[1].toLowerCase() : '';
  }

  // Cheap metadata check usable in both places (name + declared type + size)
  function validateImageMeta({ name, type, size }) {
    if (!IMAGE.extensions.includes(fileExtension(name))) return `${name || 'File'}: only JPG, JPEG, PNG or WEBP images are allowed.`;
    if (type && !IMAGE.mimeTypes.includes(type)) return `${name}: only JPG, JPEG, PNG or WEBP images are allowed.`;
    if (size > IMAGE.maxBytes) return `${name}: image is larger than ${IMAGE.maxBytes / 1024 / 1024} MB.`;
    if (size === 0) return `${name}: file is empty.`;
    return '';
  }

  // ---------- Whole-form validators ----------

  function collect(errors, field, message) {
    if (message && !errors[field]) errors[field] = message;
  }

  function validateLoginForm(v = {}) {
    const errors = {};
    if (isBlank(v.email)) errors.email = 'Email is required.';
    else {
      const m = validateEmail(v.email);
      if (m) errors.email = m;
    }
    if (typeof v.password !== 'string' || !v.password) errors.password = 'Password is required.';
    return errors;
  }

  function validateSignupForm(v = {}) {
    const errors = {};
    collect(errors, 'name', validateName(v.name));
    collect(errors, 'email', validateEmail(v.email, { restrictDomain: true }));
    collect(errors, 'mobile', validateMobile(v.mobile));
    collect(errors, 'role', validateRole(v.role));
    collect(errors, 'password', validatePassword(v.password, { name: v.name, email: v.email }));
    collect(errors, 'confirmPassword', validateConfirmPassword(v.confirmPassword, v.password));
    return errors;
  }

  // `v` holds text values; location is lat/lng. Photos are validated separately (they are files).
  function validateComplaintForm(v = {}) {
    const errors = {};
    collect(errors, 'title', validateTitle(v.title));
    collect(errors, 'description', validateDescription(v.description));
    collect(errors, 'category', validateCategory(v.category));
    if (isBlank(v.lat) || isBlank(v.lng)) {
      errors.location = 'Choose the issue location on the map before submitting.';
    } else {
      collect(errors, 'lat', validateLat(v.lat));
      collect(errors, 'lng', validateLng(v.lng));
    }
    if (!isBlank(v.accuracy)) {
      const a = toNumber(v.accuracy);
      if (!Number.isFinite(a) || a < 0) errors.accuracy = 'Accuracy must be a positive number of meters.';
    }
    collect(errors, 'address', validateAddress(v.address));
    return errors;
  }

  function validateStatusForm({ from, status, remark } = {}) {
    const errors = {};
    collect(errors, 'status', validateStatusTransition(from, status));
    const needsRemark = REMARK_REQUIRED_FOR.includes(status);
    collect(errors, 'remark', validateRemark(remark, { required: needsRemark }));
    return errors;
  }

  function validateFilters(v = {}) {
    const errors = {};
    collect(errors, 'search', validateSearch(v.search));
    if (!isBlank(v.category) && !CATEGORIES.includes(v.category)) errors.category = 'Unknown category.';
    if (!isBlank(v.status) && !STATUSES.includes(v.status)) errors.status = 'Unknown status.';
    return errors;
  }

  return {
    NAME, EMAIL, PASSWORD, TITLE, DESCRIPTION, ADDRESS, REMARK, SEARCH, IMAGE,
    ROLES, CATEGORIES, AUTO_CATEGORY, STATUSES, STATUS_TRANSITIONS, REMARK_REQUIRED_FOR, ALLOWED_EMAIL_DOMAINS, UUID,
    stripHtml, normalizeName, normalizeEmail, normalizeMobile,
    validateName, validateEmail, validateMobile, validatePassword, validateConfirmPassword, validateRole,
    validateTitle, validateDescription, validateCategory, validateLat, validateLng, validateAddress,
    validateRemark, validateSearch, validateStatusTransition, validateImageMeta,
    passwordChecks, passwordStrength, nextStatuses, sniffImageType, fileExtension,
    validateLoginForm, validateSignupForm, validateComplaintForm, validateStatusForm, validateFilters,
  };
});
