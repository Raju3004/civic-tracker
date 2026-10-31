// Place search / reverse geocoding proxy + JWT secret handling. In-memory only, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startHarness } = require('./harness');
const { createGeocoder, USER_AGENT } = require('../geocode');

let h;
let token;
const get = (p, t = token) => fetch(h.base + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} }).then(async r => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  h = await startHarness();
  const res = await fetch(h.base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Geo Tester', email: 'geo.tester@gmail.com', mobile: '9812345670', password: 'Maple$River77', confirmPassword: 'Maple$River77', role: 'citizen' }),
  });
  token = (await res.json()).token;
});
test.after(async () => { await h.close(); });

test('geocode routes require login', async () => {
  assert.equal((await get('/api/geocode/search?q=charminar', null)).status, 401);
  assert.equal((await get('/api/geocode/reverse?lat=17.4&lng=78.4', null)).status, 401);
});

test('search: validates the query and returns results', async () => {
  let r = await get('/api/geocode/search?q=ab');
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.q);
  r = await get('/api/geocode/search?q=' + 'x'.repeat(101));
  assert.equal(r.status, 400);
  r = await get('/api/geocode/search?q=%20%20Test%20Road%20%20');
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].lat, 17.4126);
  assert.deepEqual(h.geocodeCalls.at(-1), ['search', 'Test Road']);
});

test('reverse: validates lat/lng and returns an address', async () => {
  let r = await get('/api/geocode/reverse?lat=95&lng=78');
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.lat);
  r = await get('/api/geocode/reverse?lat=17.4&lng=abc');
  assert.ok(r.body.errors.lng);
  r = await get('/api/geocode/reverse?lat=17.4126&lng=78.4482');
  assert.equal(r.status, 200);
  assert.match(r.body.address, /Hyderabad/);
});

test('complaint without a location says "Location not set"', async () => {
  const f = new FormData();
  f.append('title', 'Pothole with no pin set');
  f.append('description', 'A big pothole on the road that is damaging vehicles every single day.');
  const res = await fetch(h.base + '/api/complaints', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: f });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.errors.location, /Location not set/);
});

test('geocoder sends a User-Agent, caches, and spaces upstream calls', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), ua: opts.headers['User-Agent'], at: Date.now() });
    return { ok: true, json: async () => [{ display_name: 'Charminar, Hyderabad', lat: '17.3616', lon: '78.4747' }] };
  };
  const g = createGeocoder({ fetchImpl, gapMs: 120 });
  const a = await g.search('charminar');
  await g.search('charminar'); // cached: no second upstream call
  await g.search('golconda');
  assert.deepEqual(a, [{ label: 'Charminar, Hyderabad', lat: 17.3616, lng: 78.4747 }]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.ua === USER_AGENT && /CivicTrack/.test(c.ua)));
  assert.ok(calls[1].at - calls[0].at >= 110, 'upstream calls must be spaced out');
  assert.ok(calls[0].url.startsWith('https://nominatim.openstreetmap.org/search'));
});

test('JWT secret comes from JWT_SECRET; server refuses to start without a good one', () => {
  const run = env =>
    spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: os.tmpdir(), // so dotenv cannot pick up any real .env
      env: { PATH: process.env.PATH, SUPABASE_URL: 'http://localhost:1', SUPABASE_KEY: 'x', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'x', CLOUDINARY_API_SECRET: 'x', PORT: '0', ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
  const missing = run({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required environment variables: JWT_SECRET/);
  const short = run({ JWT_SECRET: 'too-short' });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /JWT_SECRET is too short/);
});
