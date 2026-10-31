// Starts the real app (create-app.js) on a random local port with an in-memory database and a fake
// image uploader. Used by the automated checks and by the screenshot/dev mock server.
const { createApp } = require('../create-app');
const { createFakeSupabase } = require('./fake-supabase');

async function startHarness({ port = 0, seed, authRateMax = 1000, submitRateMax = 1000 } = {}) {
  const supabase = createFakeSupabase(seed);
  const uploads = [];
  const uploadImage = async buffer => {
    uploads.push(buffer.length);
    return { secure_url: `https://fake-cdn.local/img/${uploads.length}.jpg` };
  };
  const { server, io } = createApp({ supabase, uploadImage, authRateMax, submitRateMax });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    supabase,
    uploads,
    io,
    server,
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise(resolve => { io.close(); server.close(resolve); }),
  };
}

module.exports = { startHarness };
