// OpenStreetMap Nominatim client (place search + reverse geocoding).
// Runs on the server so every request carries a proper User-Agent, as the Nominatim usage policy
// requires (browsers can't set it), and so we can cache and keep to the 1 request/second limit.
const BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'CivicTrack/3.0 (+https://github.com/Raju3004/civic-tracker)';
const MIN_GAP_MS = 1100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

function createGeocoder({ fetchImpl = fetch, gapMs = MIN_GAP_MS } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastCall = 0;

  // Upstream calls are serialised and spaced out so we never exceed 1 request per second
  function throttled(task) {
    const run = queue.then(async () => {
      const wait = lastCall + gapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastCall = Date.now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function call(path, params) {
    const url = new URL(BASE + path);
    Object.entries({ format: 'jsonv2', 'accept-language': 'en', ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
    const key = url.toString();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const value = await throttled(async () => {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://github.com/Raju3004/civic-tracker', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
      return res.json();
    });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  return {
    async search(q) {
      const rows = await call('/search', { q, limit: 5, addressdetails: 0 });
      return rows
        .map(r => ({ label: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) }))
        .filter(r => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    },
    async reverse(lat, lng) {
      const r = await call('/reverse', { lat, lon: lng, zoom: 18 });
      return { address: r && r.display_name ? r.display_name : null };
    },
  };
}

module.exports = { createGeocoder, USER_AGENT };
