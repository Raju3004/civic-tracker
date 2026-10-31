// Builds the Express app + Socket.io server. External services (Supabase, Cloudinary) are injected,
// so server.js passes the real ones and the local test harness (test/) passes in-memory fakes.
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const natural = require('natural');
const http = require('http');
const { Server } = require('socket.io');
const rules = require('./shared/rules');
const { signToken, authenticate, requireRole, revokeToken } = require('./auth');
const v = require('./validation');

// ---- Automated categorization: real Naive Bayes classifier, trained locally at startup ----
const TRAINING_DATA = {
  Pothole: [
    'there is a big pothole on the road',
    'road has a large crack and is damaged',
    'asphalt is broken with a deep hole',
    'deep hole in the street causing accidents',
    'uneven road surface with cracks everywhere',
    'car damaged after hitting a hole in the road',
  ],
  Garbage: [
    'garbage is piling up on the street corner',
    'trash has not been collected for many days',
    'waste dumped illegally near the park',
    'litter scattered all over the footpath',
    'overflowing dustbin needs urgent attention',
    'bad smell from uncollected rubbish nearby',
  ],
  Streetlight: [
    'streetlight is not working at night here',
    'lamp post on this road is broken',
    'area is completely dark due to no light',
    'bulb needs replacement on the electric pole',
    'no lighting on this street after sunset',
    'flickering light near the bus stop',
  ],
  'Water Supply': [
    'water leak near the main pipeline',
    'no water supply for the past two days',
    'sewage water is flooding the street',
    'drain is blocked and water is overflowing',
    'pipe burst causing heavy water wastage',
    'dirty water coming from the tap',
  ],
  Other: [
    'stray dogs causing issues in this area',
    'loud noise pollution from nearby construction',
    'illegal parking blocking the road entrance',
    'a tree fell down after the storm yesterday',
    'general maintenance issue needs to be reported',
    'public bench is broken and unsafe to use',
  ],
};
const categoryClassifier = new natural.BayesClassifier();
Object.entries(TRAINING_DATA).forEach(([category, examples]) => {
  examples.forEach(example => categoryClassifier.addDocument(example, category));
});
categoryClassifier.train();

function guessCategory(description) {
  const text = (description || '').trim();
  if (!text) return 'Other';
  return categoryClassifier.classify(text);
}

// Haversine distance in meters — used for duplicate detection
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Word-overlap (Jaccard) text similarity, 0 to 1 — catches duplicates that are a bit
// further apart geographically but describe the same issue
function textSimilarity(a, b) {
  const words = s =>
    new Set(
      (s || '')
        .toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 2)
    );
  const wordsA = words(a);
  const wordsB = words(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Convert snake_case DB row -> camelCase for the frontend
function toClientComplaint(row) {
  const photoUrls = Array.isArray(row.photo_urls) && row.photo_urls.length ? row.photo_urls : row.photo_url ? [row.photo_url] : [];
  return {
    id: row.id,
    title: row.title || null,
    category: row.category,
    description: row.description,
    address: row.address || null,
    lat: row.lat,
    lng: row.lng,
    accuracyMeters: row.accuracy_meters,
    photoUrl: photoUrls[0] || null,
    photoUrls,
    status: row.status,
    authorityRemark: row.authority_remark || null,
    isDuplicateOf: row.is_duplicate_of,
    createdAt: row.created_at,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name,
  };
}

function rateLimitHandler(what) {
  return (req, res, next, options) => {
    const resetAt = req.rateLimit && req.rateLimit.resetTime ? req.rateLimit.resetTime.getTime() : Date.now() + options.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: `Too many ${what}, try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      retryAfterSeconds,
    });
  };
}

// ilike wildcards in user input must match literally
const escapeLike = s => s.replace(/[\\%_]/g, '\\$&');
// characters with meaning inside a PostgREST .or() filter string
const orSafe = s => s.replace(/[,()"\\*]/g, ' ');

function createApp({ supabase, uploadImage, authRateMax = 20, submitRateMax = 10 }) {
  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: authRateMax,
    handler: rateLimitHandler('attempts'),
    standardHeaders: true,
    legacyHeaders: false,
  });
  const submitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: submitRateMax,
    handler: rateLimitHandler('submissions'),
    standardHeaders: true,
    legacyHeaders: false,
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: rules.IMAGE.maxBytes, files: rules.IMAGE.maxFiles },
    fileFilter: (req, file, cb) => {
      const problem = rules.validateImageMeta({ name: file.originalname, type: file.mimetype, size: 1 });
      if (problem) {
        const err = new Error(problem);
        err.code = 'INVALID_IMAGE_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });

  app.use(cors());
  app.use(express.json({ limit: '20kb' }));
  // Frontend lives in ./public in the repo, or ../frontend in the packaged backend/ + frontend/ layout
  const publicDir = [path.join(__dirname, 'public'), path.join(__dirname, '..', 'frontend')].find(d => fs.existsSync(d));
  app.use(express.static(publicDir));
  app.use('/shared', express.static(path.join(__dirname, 'shared')));

  // ---- Auth routes ----

  app.post(
    '/api/auth/signup',
    authLimiter,
    v.sanitizeInputs,
    v.requireStringFields('name', 'email', 'mobile', 'password', 'confirmPassword', 'role'),
    v.validateSignup,
    async (req, res) => {
      const name = rules.normalizeName(req.body.name);
      const email = rules.normalizeEmail(req.body.email);
      const mobile = rules.normalizeMobile(req.body.mobile);
      const { password, role } = req.body;

      const { data: existing, error: lookupError } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (lookupError) {
        return res.status(500).json({ error: 'Database error checking existing account: ' + lookupError.message });
      }
      if (existing) {
        return res.status(409).json({ errors: { email: 'An account with this email already exists.' } });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const { data: user, error: insertError } = await supabase
        .from('users')
        .insert({ name, email, mobile, password_hash: passwordHash, role })
        .select()
        .single();
      if (insertError) {
        return res.status(500).json({ error: 'Could not create account: ' + insertError.message });
      }

      const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }
  );

  app.post(
    '/api/auth/login',
    authLimiter,
    v.sanitizeInputs,
    v.requireStringFields('email', 'password'),
    v.validateLogin,
    async (req, res) => {
      const email = rules.normalizeEmail(req.body.email);
      const { password } = req.body;
      const INVALID = { error: 'Invalid email or password' };

      // Anything longer than a valid password can't be right — answer exactly like a wrong password
      if (password.length > rules.PASSWORD.max) return res.status(401).json(INVALID);

      const { data: user, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
      if (error) {
        return res.status(500).json({ error: 'Database error during login: ' + error.message });
      }
      if (!user) return res.status(401).json(INVALID);

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json(INVALID);

      const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }
  );

  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/logout', authenticate, (req, res) => {
    revokeToken(req.token);
    res.json({ success: true });
  });

  // ---- Complaint routes (all require login) ----

  app.get('/api/complaints', authenticate, v.sanitizeInputs, v.validateComplaintFilters, async (req, res) => {
    let query = supabase.from('complaints').select('*').order('created_at', { ascending: false });

    const category = (req.query.category || '').trim();
    const status = (req.query.status || '').trim();
    const search = (req.query.search || '').trim();
    if (category) query = query.eq('category', category);
    if (status) query = query.eq('status', status);
    if (search) {
      const term = `%${escapeLike(orSafe(search))}%`;
      query = query.or(`description.ilike.${term},title.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Could not fetch complaints: ' + error.message });
    res.json(data.map(toClientComplaint));
  });

  app.get('/api/complaints/mine', authenticate, requireRole('citizen'), async (req, res) => {
    const { data, error } = await supabase
      .from('complaints')
      .select('*')
      .eq('submitted_by', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Could not fetch your complaints: ' + error.message });
    res.json(data.map(toClientComplaint));
  });

  app.get('/api/stats', authenticate, async (req, res) => {
    const { data, error } = await supabase.from('complaints').select('status, is_duplicate_of');
    if (error) return res.status(500).json({ error: 'Could not fetch stats: ' + error.message });
    res.json({
      total: data.length,
      pending: data.filter(c => c.status === 'Pending').length,
      inProgress: data.filter(c => c.status === 'In Progress').length,
      resolved: data.filter(c => c.status === 'Resolved').length,
      rejected: data.filter(c => c.status === 'Rejected').length,
      duplicates: data.filter(c => c.is_duplicate_of).length,
    });
  });

  app.post(
    '/api/complaints',
    authenticate,
    requireRole('citizen'),
    submitLimiter,
    v.handleUploadErrors(upload.array('photos', rules.IMAGE.maxFiles)),
    v.sanitizeInputs,
    v.requireStringFields('title', 'description', 'category', 'lat', 'lng', 'accuracy', 'address'),
    v.validateComplaintCreate,
    async (req, res) => {
      const title = rules.stripHtml(req.body.title).trim();
      const description = rules.stripHtml(req.body.description).trim();
      const address = req.body.address ? rules.stripHtml(req.body.address).trim() : null;
      const lat = parseFloat(req.body.lat);
      const lng = parseFloat(req.body.lng);
      const accuracy = req.body.accuracy ? parseFloat(req.body.accuracy) : null;
      const { category } = req.body;

      const finalCategory = category && category !== rules.AUTO_CATEGORY ? category : guessCategory(description);

      let photoUrls = [];
      const files = req.files || [];
      if (files.length) {
        try {
          const results = await Promise.all(files.map(f => uploadImage(f.buffer)));
          photoUrls = results.map(r => r.secure_url);
        } catch (err) {
          return res.status(400).json({ error: 'Photo upload failed — double check your Cloudinary credentials in .env.' });
        }
      }

      // Duplicate detection: same category, unresolved, AND either within 50m outright,
      // OR within 150m with high text similarity (catches near-identical reports that
      // GPS placed slightly further apart than the strict radius)
      let duplicateOf = null;
      const { data: candidates, error: candErr } = await supabase
        .from('complaints')
        .select('id, lat, lng, description')
        .eq('category', finalCategory)
        .neq('status', 'Resolved')
        .not('lat', 'is', null)
        .not('lng', 'is', null);
      if (candErr) return res.status(500).json({ error: 'Could not check for duplicates: ' + candErr.message });

      const match = (candidates || []).find(c => {
        const dist = distanceMeters(lat, lng, c.lat, c.lng);
        if (dist < 50) return true;
        if (dist < 150 && textSimilarity(description, c.description) > 0.4) return true;
        return false;
      });
      if (match) duplicateOf = match.id;

      const { data: complaint, error } = await supabase
        .from('complaints')
        .insert({
          title,
          category: finalCategory,
          description,
          address,
          lat,
          lng,
          accuracy_meters: accuracy,
          photo_url: photoUrls[0] || null,
          photo_urls: photoUrls,
          status: 'Pending',
          is_duplicate_of: duplicateOf,
          submitted_by: req.user.id,
          submitted_by_name: req.user.name,
        })
        .select()
        .single();
      if (error) return res.status(500).json({ error: 'Could not save complaint: ' + error.message });

      io.emit('complaint:new', toClientComplaint(complaint));
      res.json(toClientComplaint(complaint));
    }
  );

  app.patch(
    '/api/complaints/:id/status',
    authenticate,
    requireRole('authority'),
    v.validateIdParam,
    v.sanitizeInputs,
    v.requireStringFields('status', 'remark'),
    v.validateStatusBody,
    async (req, res) => {
      const { status } = req.body;
      const remark = rules.stripHtml(req.body.remark || '').trim();

      const { data: current, error: loadErr } = await supabase
        .from('complaints')
        .select('id, status')
        .eq('id', req.params.id)
        .maybeSingle();
      if (loadErr) return res.status(500).json({ error: 'Could not load complaint: ' + loadErr.message });
      if (!current) return res.status(404).json({ error: 'Complaint not found.' });

      const errors = rules.validateStatusForm({ from: current.status, status, remark });
      if (Object.keys(errors).length) return v.sendValidationErrors(res, errors);

      const changes = { status };
      if (remark) changes.authority_remark = remark;

      // Only update if nobody changed the status since we read it (two authorities at once)
      const { data, error } = await supabase
        .from('complaints')
        .update(changes)
        .eq('id', req.params.id)
        .eq('status', current.status)
        .select()
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Could not update status: ' + error.message });
      if (!data) return res.status(409).json({ error: 'Someone else just updated this complaint. Refresh and try again.' });

      io.emit('complaint:updated', toClientComplaint(data));
      res.json(toClientComplaint(data));
    }
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    console.error('Request error:', err.message);
    const friendly =
      err.http_code === 401 || /invalid.*(api|signature|credentials)/i.test(err.message || '')
        ? 'Photo upload failed — double check your Cloudinary credentials in .env.'
        : err.message || 'Something went wrong.';
    res.status(err.http_code || 500).json({ error: friendly });
  });

  return { app, server, io };
}

module.exports = { createApp, guessCategory, distanceMeters, textSimilarity, toClientComplaint };
