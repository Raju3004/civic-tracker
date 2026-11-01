// Local-only dev server: the real app on top of an in-memory database with seeded demo data.
// No Supabase, no Cloudinary, no .env. Usage: node test/mock-server.js [port]
const bcrypt = require('bcryptjs');
const { startHarness } = require('./harness');

const DEMO_PASSWORD = 'Demo#Pass2025'; // exists only inside this in-memory fixture

function photo(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="hsl(${hue},45%,38%)"/><circle cx="190" cy="40" r="22" fill="hsl(${hue},60%,70%)" opacity=".7"/><rect y="110" width="240" height="50" fill="hsl(${hue},30%,22%)"/><text x="12" y="146" fill="#fff" font-family="sans-serif" font-size="16" font-weight="700">${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

async function main() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 8);
  const users = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Meera Reddy', email: 'meera.reddy@gmail.com', mobile: '9876500001', password_hash: hash, role: 'citizen', created_at: new Date().toISOString() },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Arjun Nair', email: 'arjun.nair@gmail.com', mobile: '9876500002', password_hash: hash, role: 'authority', created_at: new Date().toISOString() },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Kiran Rao', email: 'kiran.rao@gmail.com', mobile: '9876500003', password_hash: hash, role: 'citizen', created_at: new Date().toISOString() },
  ];
  const ago = mins => new Date(Date.now() - mins * 60000).toISOString();
  const mk = (n, o) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, accuracy_meters: 12, is_duplicate_of: null, photo_url: null, photo_urls: [], authority_remark: null, address: null, submitted_by: users[0].id, submitted_by_name: users[0].name, ...o });
  const complaints = [
    mk(1, { title: 'Deep pothole near Jubilee Hills check post', category: 'Pothole', description: 'A very deep pothole has formed in the left lane and two bikes have already skidded here this week.', lat: 17.4326, lng: 78.4071, address: 'Road No. 36, Jubilee Hills', status: 'Pending', created_at: ago(35), photo_urls: [photo('Pothole', 150)] }),
    mk(2, { title: 'Garbage not collected for five days', category: 'Garbage', description: 'The bin at the corner of the market overflows and the smell is spreading to nearby houses and shops.', lat: 17.4401, lng: 78.3489, status: 'In Progress', created_at: ago(60 * 26), photo_urls: [photo('Garbage', 38)] }),
    mk(3, { title: 'Streetlight out on Park Lane', category: 'Streetlight', description: 'The streetlight outside the park has been dark for two weeks and the footpath is unsafe at night.', lat: 17.3871, lng: 78.4912, status: 'Resolved', authority_remark: 'Replaced the faulty lamp and tested it after dark.', created_at: ago(60 * 24 * 6) }),
    mk(4, { title: 'Water pipe leaking onto the road', category: 'Water Supply', description: 'A main water pipe is leaking continuously and clean water is flooding the road in front of the school.', lat: 17.3616, lng: 78.4747, status: 'Rejected', authority_remark: 'This pipe belongs to a private society and is outside municipal limits.', created_at: ago(60 * 24 * 3), submitted_by: users[2].id, submitted_by_name: users[2].name }),
    mk(5, { title: 'Stray dogs near the bus stop', category: 'Other', description: 'A pack of stray dogs gathers near the bus stop every evening and has chased several commuters.', lat: 17.4486, lng: 78.3908, status: 'Pending', created_at: ago(60 * 5), submitted_by: users[2].id, submitted_by_name: users[2].name }),
    mk(6, { title: 'Pothole near Jubilee Hills check post', category: 'Pothole', description: 'Deep pothole in the left lane near the check post, bikes are skidding every day here.', lat: 17.43262, lng: 78.40712, status: 'Pending', is_duplicate_of: 'aaaaaaaa-0000-4000-8000-000000000001', created_at: ago(12) }),
  ];
  const port = Number(process.argv[2]) || 4010;
  const h = await startHarness({ port, seed: { users, complaints }, authRateMax: Number(process.env.AUTH_RATE_MAX) || 200, submitRateMax: 200 });
  console.log(`CivicTrack MOCK server (in-memory data) on ${h.base}`);
  console.log(`Demo logins -> citizen: meera.reddy@gmail.com | authority: arjun.nair@gmail.com | password: ${DEMO_PASSWORD}`);
}
main();
