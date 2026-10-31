// Express validation middleware. Rules themselves live in shared/rules.js so the browser uses the same ones.
const rules = require('./shared/rules');

// Fields that must reach the handler untouched (stripping HTML would silently change a password)
const RAW_FIELDS = new Set(['password', 'confirmPassword']);

function sanitizeObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    out[key] = typeof value === 'string' && !RAW_FIELDS.has(key) ? rules.stripHtml(value) : value;
  }
  return out;
}

// Strip HTML from every text input in the body and query string
function sanitizeInputs(req, res, next) {
  if (req.body && typeof req.body === 'object') req.body = sanitizeObject(req.body);
  if (req.query && typeof req.query === 'object') {
    const cleaned = sanitizeObject(req.query);
    Object.keys(req.query).forEach(k => delete req.query[k]);
    Object.assign(req.query, cleaned);
  }
  next();
}

function sendValidationErrors(res, errors) {
  return res.status(400).json({ errors });
}

// validate((req) => ({ field: 'message' })) -> middleware that answers 400 { errors } when non-empty
function validate(getErrors) {
  return (req, res, next) => {
    const errors = getErrors(req);
    if (errors && Object.keys(errors).length) return sendValidationErrors(res, errors);
    next();
  };
}

// Every route that takes text input must receive strings; arrays/objects are rejected up front
function requireStringFields(...names) {
  return validate(req => {
    const errors = {};
    names.forEach(name => {
      const value = (req.body || {})[name];
      if (value !== undefined && typeof value !== 'string') errors[name] = 'Must be text.';
    });
    return errors;
  });
}

// ---- Auth ----
const validateSignup = validate(req => rules.validateSignupForm(req.body));
const validateLogin = validate(req => rules.validateLoginForm(req.body));

// ---- Complaints ----
const validateComplaintCreate = validate(req => {
  const errors = rules.validateComplaintForm(req.body);
  const files = req.files || [];
  if (files.length > rules.IMAGE.maxFiles) {
    errors.photos = `You can upload at most ${rules.IMAGE.maxFiles} images.`;
  }
  for (const file of files) {
    // 1) name/declared type/size, 2) the real bytes — a renamed .exe or .html must not pass
    const metaError = rules.validateImageMeta({ name: file.originalname, type: file.mimetype, size: file.size });
    const sniffed = rules.sniffImageType(file.buffer);
    if (metaError) {
      errors.photos = metaError;
      break;
    }
    if (!sniffed) {
      errors.photos = `${file.originalname}: file content is not a valid JPG, PNG or WEBP image.`;
      break;
    }
  }
  return errors;
});

const validateIdParam = validate(req =>
  rules.UUID.test(req.params.id || '') ? {} : { id: 'Invalid complaint id.' }
);

// Status transitions depend on the stored status, so the handler calls rules.validateStatusForm
// after loading the row; this middleware covers everything that can be checked without the database.
const validateStatusBody = validate(req => {
  const { status, remark } = req.body || {};
  const errors = {};
  if (typeof status !== 'string' || !rules.STATUSES.includes(status)) {
    errors.status = `Status must be one of: ${rules.STATUSES.join(', ')}.`;
  }
  if (remark !== undefined && typeof remark !== 'string') errors.remark = 'Must be text.';
  else {
    const remarkError = rules.validateRemark(remark, { required: rules.REMARK_REQUIRED_FOR.includes(status) });
    if (remarkError) errors.remark = remarkError;
  }
  return errors;
});

const validateComplaintFilters = validate(req => rules.validateFilters(req.query));

// ---- Multer error translation: limits become field errors instead of generic 500s ----
function handleUploadErrors(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, err => {
      if (!err) return next();
      const map = {
        LIMIT_FILE_SIZE: `Each image must be ${rules.IMAGE.maxBytes / 1024 / 1024} MB or smaller.`,
        LIMIT_FILE_COUNT: `You can upload at most ${rules.IMAGE.maxFiles} images.`,
        LIMIT_UNEXPECTED_FILE: `Upload images in the "photos" field, at most ${rules.IMAGE.maxFiles}.`,
      };
      if (err.code && map[err.code]) return sendValidationErrors(res, { photos: map[err.code] });
      if (err.code === 'INVALID_IMAGE_TYPE') return sendValidationErrors(res, { photos: err.message });
      return next(err);
    });
  };
}

module.exports = {
  sanitizeInputs,
  validate,
  requireStringFields,
  validateSignup,
  validateLogin,
  validateComplaintCreate,
  validateIdParam,
  validateStatusBody,
  validateComplaintFilters,
  handleUploadErrors,
  sendValidationErrors,
};
