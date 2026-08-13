require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const natural = require('natural');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const { signToken, authenticate, requireRole, isValidEmail, revokeToken } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

// ---- Fail fast with a clear message if credentials are missing ----
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in real values before starting the server.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---- Rate limiting ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many submissions. Please slow down and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---- Automated categorization: real Naive Bayes classifier, trained locally at startup ----
const categoryClassifier = new natural.BayesClassifier();
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
Object.entries(TRAINING_DATA).forEach(([category, examples]) => {
  examples.forEach(example => categoryClassifier.addDocument(example, category));
});
categoryClassifier.train();

function guessCategory(description) {
  const text = (description || '').trim();
  if (!text) return 'Other';
  return categoryClassifier.classify(text);
}

// Upload a buffer to Cloudinary directly — no extra storage-engine package needed
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: 'civictrack' }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for photo evidence.'));
    }
    cb(null, true);
  },
});

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

// Word-overlap (Jaccard) text similarity, 0 to 1 — used to catch duplicates that
// are a bit further apart geographically but describe the same issue
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

// ---- Validation helpers ----
const NAME_REGEX = /^[a-zA-Z][a-zA-Z\s.'-]{1,49}$/;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;
const ALLOWED_CATEGORIES = ['Pothole', 'Garbage', 'Streetlight', 'Water Supply', 'Other'];
const ALLOWED_STATUSES = ['Pending', 'In Progress', 'Resolved'];

function isValidName(name) {
  return typeof name === 'string' && NAME_REGEX.test(name.trim());
}
function isValidPassword(password) {
  return typeof password === 'string' && PASSWORD_REGEX.test(password);
}
function isValidLat(lat) {
  const n = parseFloat(lat);
  return !Number.isNaN(n) && n >= -90 && n <= 90;
}
function isValidLng(lng) {
  const n = parseFloat(lng);
  return !Number.isNaN(n) && n >= -180 && n <= 180;
}

// Convert snake_case DB row -> camelCase for the frontend (keeps app.js unchanged)
function toClientComplaint(row) {
  return {
    id: row.id,
    category: row.category,
    description: row.description,
    lat: row.lat,
    lng: row.lng,
    accuracyMeters: row.accuracy_meters,
    photoUrl: row.photo_url,
    status: row.status,
    isDuplicateOf: row.is_duplicate_of,
    createdAt: row.created_at,
    submittedBy: row.submitted_by,
    submittedByName: row.submitted_by_name,
  };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth routes ----

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password, and role are all required.' });
  }
  if (!isValidName(name)) {
    return res.status(400).json({ error: 'Name must be 2-50 letters (spaces, hyphens, apostrophes allowed).' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!['citizen', 'authority'].includes(role)) {
    return res.status(400).json({ error: 'Role must be citizen or authority.' });
  }
  if (!isValidPassword(password)) {
    return res
      .status(400)
      .json({ error: 'Password must be at least 6 characters and include a letter and a number.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (lookupError) {
    return res.status(500).json({ error: 'Database error checking existing account: ' + lookupError.message });
  }
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: user, error: insertError } = await supabase
    .from('users')
    .insert({ name: name.trim(), email: normalizedEmail, password_hash: passwordHash, role })
    .select()
    .single();
  if (insertError) {
    return res.status(500).json({ error: 'Could not create account: ' + insertError.message });
  }

  const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (error) {
    return res.status(500).json({ error: 'Database error during login: ' + error.message });
  }
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', authenticate, (req, res) => {
  revokeToken(req.token);
  res.json({ success: true });
});

// ---- Complaint routes (all require login) ----

app.get('/api/complaints', authenticate, async (req, res) => {
  let query = supabase.from('complaints').select('*').order('created_at', { ascending: false });

  const { category, status, search } = req.query;
  if (category && ALLOWED_CATEGORIES.includes(category)) query = query.eq('category', category);
  if (status && ALLOWED_STATUSES.includes(status)) query = query.eq('status', status);
  if (search && search.trim()) query = query.ilike('description', `%${search.trim()}%`);

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
    duplicates: data.filter(c => c.is_duplicate_of).length,
  });
});

app.post('/api/complaints', authenticate, requireRole('citizen'), submitLimiter, upload.single('photo'), async (req, res) => {
  const { category, description, lat, lng, accuracy } = req.body;

  if (!description || description.trim().length < 10) {
    return res.status(400).json({ error: 'Description must be at least 10 characters.' });
  }
  if (category && category !== 'Auto-detect' && !ALLOWED_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category selected.' });
  }
  if (lat !== undefined && lat !== '' && !isValidLat(lat)) {
    return res.status(400).json({ error: 'Invalid latitude.' });
  }
  if (lng !== undefined && lng !== '' && !isValidLng(lng)) {
    return res.status(400).json({ error: 'Invalid longitude.' });
  }
  if ((lat && !lng) || (lng && !lat)) {
    return res.status(400).json({ error: 'Both latitude and longitude are required together.' });
  }

  const finalCategory = category && category !== 'Auto-detect' ? category : guessCategory(description);

  let photoUrl = null;
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer);
      photoUrl = result.secure_url;
    } catch (err) {
      return res
        .status(400)
        .json({ error: 'Photo upload failed — double check your Cloudinary credentials in .env.' });
    }
  }

  // Duplicate detection: same category, unresolved, AND either within 50m outright,
  // OR within 150m with high text similarity (catches near-identical reports that
  // GPS placed slightly further apart than the strict radius)
  let duplicateOf = null;
  if (lat && lng) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const { data: candidates, error: candErr } = await supabase
      .from('complaints')
      .select('id, lat, lng, description')
      .eq('category', finalCategory)
      .neq('status', 'Resolved')
      .not('lat', 'is', null)
      .not('lng', 'is', null);
    if (candErr) return res.status(500).json({ error: 'Could not check for duplicates: ' + candErr.message });

    const match = (candidates || []).find(c => {
      const dist = distanceMeters(latNum, lngNum, c.lat, c.lng);
      if (dist < 50) return true;
      if (dist < 150 && textSimilarity(description, c.description) > 0.4) return true;
      return false;
    });
    if (match) duplicateOf = match.id;
  }

  const { data: complaint, error } = await supabase
    .from('complaints')
    .insert({
      category: finalCategory,
      description: description.trim(),
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      accuracy_meters: accuracy ? parseFloat(accuracy) : null,
      photo_url: photoUrl,
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
});

app.patch('/api/complaints/:id/status', authenticate, requireRole('authority'), async (req, res) => {
  const { status } = req.body;
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status must be Pending, In Progress, or Resolved.' });
  }

  const { data, error } = await supabase
    .from('complaints')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not update status: ' + error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });

  io.emit('complaint:updated', toClientComplaint(data));
  res.json(toClientComplaint(data));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Request error:', err.message);
  const friendly =
    err.http_code === 401 || /invalid.*(api|signature|credentials)/i.test(err.message || '')
      ? 'Photo upload failed — double check your Cloudinary credentials in .env.'
      : err.message || 'Something went wrong.';
  res.status(err.http_code || 500).json({ error: friendly });
});

server.listen(PORT, () => {
  console.log(`Civic Issue Tracker (Supabase + Cloudinary + Socket.io) running at http://localhost:${PORT}`);
});
