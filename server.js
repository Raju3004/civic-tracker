require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const { createApp } = require('./create-app');

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

// Upload a buffer to Cloudinary directly — no extra storage-engine package needed
function uploadImage(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: 'civictrack' }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

const { server } = createApp({ supabase, uploadImage });

server.listen(PORT, () => {
  console.log(`Civic Issue Tracker (Supabase + Cloudinary + Socket.io) running at http://localhost:${PORT}`);
});
