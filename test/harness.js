// Starts the real app (create-app.js) on a random local port with an in-memory database and a fake
// image uploader. Used by the automated checks and by the screenshot/dev mock server.
// Test-only signing secret (the real one comes from the JWT_SECRET env var)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-test-only-secret-0123456789';
const { createApp } = require('../create-app');
const { createFakeSupabase } = require('./fake-supabase');

async function startHarness({ port = 0, seed, authRateMax = 1000, submitRateMax = 1000 } = {}) {
  const supabase = createFakeSupabase(seed);
  const uploads = [];
  const uploadImage = async buffer => {
    uploads.push(buffer.length);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#5f9a6e"/><text x="12" y="146" fill="#fff" font-family="sans-serif" font-size="16">photo ${uploads.length}</text></svg>`;
    return { secure_url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) };
  };
  const geocodeCalls = [];
  const geocoder = {
    search: async q => { geocodeCalls.push(['search', q]); return [{ label: 'Test Road, Hyderabad, Telangana, India', lat: 17.4126, lng: 78.4482 }]; },
    reverse: async (lat, lng) => { geocodeCalls.push(['reverse', lat, lng]); return { address: 'Test Road, Hyderabad, Telangana, India' }; },
  };
  const { server, io } = createApp({ supabase, uploadImage, geocoder, authRateMax, submitRateMax });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    supabase,
    uploads,
    geocodeCalls,
    io,
    server,
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise(resolve => { io.close(); server.close(resolve); }),
  };
}

module.exports = { startHarness };
