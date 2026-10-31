// Run with: npm test   (node --test). Uses an in-memory database; never touches Supabase or Cloudinary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startHarness } = require('./harness');

let h;
const json = (method, path, body, token) =>
  fetch(h.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = async res => ({ status: res.status, body: await res.json() });

const GOOD_SIGNUP = {
  name: "Asha O'Neil-Rao",
  email: 'asha.rao@gmail.com',
  mobile: '9876543210',
  password: 'Zebra#Cloud42',
  confirmPassword: 'Zebra#Cloud42',
  role: 'citizen',
};
async function signup(overrides) {
  return read(await json('POST', '/api/auth/signup', { ...GOOD_SIGNUP, ...overrides }));
}

// 1x1 PNG / minimal JPEG / WEBP headers — real magic bytes so the content sniffing passes
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000000050001a5f645400000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(30)]);

function complaintForm(fields = {}, files = []) {
  const f = new FormData();
  const base = {
    title: 'Large pothole near bus stop',
    description: 'There is a large pothole on the main road near the bus stop that damages vehicles.',
    category: 'Auto-detect',
    lat: '17.385',
    lng: '78.4867',
    accuracy: '12',
  };
  Object.entries({ ...base, ...fields }).forEach(([k, val]) => val !== null && f.append(k, val));
  files.forEach(({ name, type, data }) => f.append('photos', new Blob([data], { type }), name));
  return f;
}
const post = (form, token) =>
  fetch(h.base + '/api/complaints', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(read);

test.before(async () => { h = await startHarness(); });
test.after(async () => { await h.close(); });

// ---------------- Signup ----------------
test('signup: every rule returns 400 with the right field error', async () => {
  const cases = [
    [{ name: '' }, 'name'],
    [{ name: 'A' }, 'name'],
    [{ name: 'x'.repeat(51) }, 'name'],
    [{ name: 'Asha123' }, 'name'],
    [{ name: 'Asha  Rao' }, 'name'],
    [{ email: '' }, 'email'],
    [{ email: 'not-an-email' }, 'email'],
    [{ email: 'a..b@gmail.com' }, 'email'],
    [{ email: 'a b@gmail.com' }, 'email'],
    [{ email: 'a'.repeat(250) + '@gmail.com' }, 'email'],
    [{ email: 'someone@unknown-provider.org' }, 'email'],
    [{ mobile: '' }, 'mobile'],
    [{ mobile: '12345' }, 'mobile'],
    [{ mobile: '5876543210' }, 'mobile'],
    [{ mobile: '9999999999' }, 'mobile'],
    [{ password: 'Sh0rt!a', confirmPassword: 'Sh0rt!a' }, 'password'],
    [{ password: 'x'.repeat(65) + 'A1!', confirmPassword: 'x'.repeat(65) + 'A1!' }, 'password'],
    [{ password: 'alllowercase1!', confirmPassword: 'alllowercase1!' }, 'password'],
    [{ password: 'ALLUPPERCASE1!', confirmPassword: 'ALLUPPERCASE1!' }, 'password'],
    [{ password: 'NoNumbers!!Here', confirmPassword: 'NoNumbers!!Here' }, 'password'],
    [{ password: 'NoSymbols12345A', confirmPassword: 'NoSymbols12345A' }, 'password'],
    [{ password: 'Has Space#12ab', confirmPassword: 'Has Space#12ab' }, 'password'],
    [{ password: 'Ashaoneil#1234', confirmPassword: 'Ashaoneil#1234' }, 'password'], // contains name token
    [{ password: 'Xx.rao#1234Q', confirmPassword: 'Xx.rao#1234Q' }, 'password'], // contains email local part? (asha.rao)
    [{ confirmPassword: 'Different#Pass1' }, 'confirmPassword'],
    [{ confirmPassword: '' }, 'confirmPassword'],
    [{ role: 'admin' }, 'role'],
    [{ role: undefined }, 'role'],
  ];
  for (const [override, field] of cases) {
    // the "email local part" case needs the password to actually contain it
    const o = field === 'password' && override.password === 'Xx.rao#1234Q' ? { ...override, password: 'Xx.Asha.rao#1234', confirmPassword: 'Xx.Asha.rao#1234' } : override;
    const { status, body } = await signup(o);
    assert.equal(status, 400, `${JSON.stringify(override)} should be 400`);
    assert.ok(body.errors && typeof body.errors[field] === 'string', `${JSON.stringify(override)} -> errors.${field}, got ${JSON.stringify(body)}`);
  }
});

test('signup: non-string fields are rejected', async () => {
  const { status, body } = await signup({ name: ['a', 'b'], email: { x: 1 } });
  assert.equal(status, 400);
  assert.ok(body.errors.name && body.errors.email);
});

test('signup: HTML is stripped from text inputs, then validated', async () => {
  const { status, body } = await signup({ name: '<script>alert(1)</script>', email: 'xss.test@gmail.com' });
  assert.equal(status, 400); // nothing left after stripping
  assert.ok(body.errors.name);
  const ok = await signup({ name: 'Ravi <b>Kumar</b>', email: 'ravi.k@gmail.com' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Ravi Kumar');
});

test('signup: succeeds, normalises email, rejects duplicates with a field error', async () => {
  const res = await signup({ email: '  Asha.Rao@Gmail.com ', mobile: '+919876543210' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'asha.rao@gmail.com');
  assert.equal(h.supabase.db.tables.users.find(u => u.email === 'asha.rao@gmail.com').mobile, '9876543210');
  const dup = await signup({});
  assert.equal(dup.status, 409);
  assert.ok(dup.body.errors.email);
});

// ---------------- Login ----------------
test('login: required + format errors are field-level 400s', async () => {
  let r = await read(await json('POST', '/api/auth/login', {}));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.email && r.body.errors.password);
  r = await read(await json('POST', '/api/auth/login', { email: 'nope', password: 'x' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.email);
  r = await read(await json('POST', '/api/auth/login', { email: 'asha.rao@gmail.com', password: '' }));
  assert.ok(r.body.errors.password);
});

test('login: wrong email and wrong password give the same message', async () => {
  const wrongPass = await read(await json('POST', '/api/auth/login', { email: 'asha.rao@gmail.com', password: 'Wrong#Pass123' }));
  const noUser = await read(await json('POST', '/api/auth/login', { email: 'ghost@gmail.com', password: 'Wrong#Pass123' }));
  const tooLong = await read(await json('POST', '/api/auth/login', { email: 'asha.rao@gmail.com', password: 'x'.repeat(200) }));
  for (const r of [wrongPass, noUser, tooLong]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid email or password');
  }
});

test('login: rate limit returns a clear "try again in X minutes" message', async () => {
  const limited = await startHarness({ authRateMax: 3 });
  try {
    let last;
    for (let i = 0; i < 5; i++) {
      last = await fetch(limited.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@gmail.com', password: 'x' }) });
    }
    const body = await last.json();
    assert.equal(last.status, 429);
    assert.match(body.error, /^Too many attempts, try again in \d+ minutes?\.$/);
    assert.ok(body.retryAfterSeconds > 0);
  } finally {
    await limited.close();
  }
});

// ---------------- Complaints ----------------
let citizen, authority;
test('setup users', async () => {
  const c = await signup({ email: 'citizen.one@gmail.com', name: 'Citizen One', password: 'Maple$River77', confirmPassword: 'Maple$River77' });
  citizen = c.body.token;
  const a = await signup({ email: 'officer.two@gmail.com', name: 'Officer Two', role: 'authority', mobile: '9123456780', password: 'Granite&Moon88', confirmPassword: 'Granite&Moon88' });
  authority = a.body.token;
  assert.ok(citizen && authority);
});

test('complaint: every text/location rule returns 400 with the right field', async () => {
  const cases = [
    [{ title: '' }, 'title'],
    [{ title: 'abcd' }, 'title'],
    [{ title: 'x'.repeat(101) }, 'title'],
    [{ title: '<b></b>' }, 'title'],
    [{ description: '' }, 'description'],
    [{ description: 'too short to count' }, 'description'],
    [{ description: 'y'.repeat(1001) }, 'description'],
    [{ category: 'Potholes' }, 'category'],
    [{ lat: null, lng: null }, 'location'],
    [{ lng: null }, 'location'],
    [{ lat: '91' }, 'lat'],
    [{ lat: '-90.5' }, 'lat'],
    [{ lat: 'abc' }, 'lat'],
    [{ lng: '181' }, 'lng'],
    [{ lng: '-180.1' }, 'lng'],
    [{ accuracy: '-3' }, 'accuracy'],
    [{ address: 'z'.repeat(201) }, 'address'],
  ];
  for (const [override, field] of cases) {
    const { status, body } = await post(complaintForm(override), citizen);
    assert.equal(status, 400, JSON.stringify(override));
    assert.ok(body.errors && body.errors[field], `${JSON.stringify(override)} -> errors.${field}, got ${JSON.stringify(body)}`);
  }
});

test('complaint: image rules (type by content, size, count)', async () => {
  const bad = async (files, label) => {
    const { status, body } = await post(complaintForm({}, files), citizen);
    assert.equal(status, 400, label);
    assert.ok(body.errors && body.errors.photos, `${label}: ${JSON.stringify(body)}`);
  };
  await bad([{ name: 'a.gif', type: 'image/gif', data: PNG }], 'gif extension');
  await bad([{ name: 'a.jpg', type: 'image/jpeg', data: Buffer.from('this is plain text, not an image at all') }], 'text renamed .jpg');
  await bad([{ name: 'a.png', type: 'image/png', data: Buffer.from('<html><script>alert(1)</script></html>') }], 'html renamed .png');
  await bad([{ name: 'a.jpg', type: 'image/jpeg', data: PNG }].concat([{ name: 'b.exe', type: 'application/octet-stream', data: PNG }]), 'exe');
  await bad([{ name: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }], 'over 5 MB');
  await bad(Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png`, type: 'image/png', data: PNG })), 'six files');
  assert.equal(h.uploads.length, 0, 'nothing may be uploaded when validation fails');
});

test('complaint: valid submit with 3 images, classifier fills category, XSS stripped', async () => {
  const { status, body } = await post(
    complaintForm(
      { title: 'Broken <img src=x onerror=alert(1)> streetlight', description: 'The streetlight on this road is not working at night and the whole area is completely dark.', address: 'Near <b>Main</b> Road' },
      [
        { name: 'a.jpg', type: 'image/jpeg', data: JPEG },
        { name: 'b.png', type: 'image/png', data: PNG },
        { name: 'c.webp', type: 'image/webp', data: WEBP },
      ]
    ),
    citizen
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.category, 'Streetlight'); // Naive Bayes, no category chosen
  assert.equal(body.title, 'Broken  streetlight');
  assert.equal(body.address, 'Near Main Road');
  assert.equal(body.photoUrls.length, 3);
  assert.equal(body.status, 'Pending');
});

test('duplicate detection still flags nearby same-category reports', async () => {
  const first = await post(complaintForm({ title: 'Garbage pile at the corner', description: 'Garbage is piling up on the street corner and nobody has collected the trash.', lat: '17.4000', lng: '78.5000' }), citizen);
  assert.equal(first.status, 200);
  assert.equal(first.body.category, 'Garbage');
  assert.equal(first.body.isDuplicateOf, null);
  const near = await post(complaintForm({ title: 'Trash not collected here', description: 'Overflowing dustbin and rubbish scattered, waste needs urgent collection now.', category: 'Garbage', lat: '17.40010', lng: '78.50010' }), citizen);
  assert.equal(near.body.isDuplicateOf, first.body.id);
  const far = await post(complaintForm({ title: 'Trash far away from there', description: 'Overflowing dustbin and rubbish scattered, waste needs urgent collection now.', category: 'Garbage', lat: '17.5000', lng: '78.6000' }), citizen);
  assert.equal(far.body.isDuplicateOf, null);
});

test('citizen only sees own complaints; authority cannot submit', async () => {
  const mine = await read(await json('GET', '/api/complaints/mine', undefined, citizen));
  assert.equal(mine.status, 200);
  assert.ok(mine.body.length >= 3);
  assert.ok(mine.body.every(c => c.submittedByName === 'Citizen One'));
  const denied = await post(complaintForm(), authority);
  assert.equal(denied.status, 403);
  const forbidden = await read(await json('GET', '/api/complaints/mine', undefined, authority));
  assert.equal(forbidden.status, 403);
});

test('search and filters: trimmed, max 100, allowed values only', async () => {
  const bad = async (qs, field) => {
    const r = await read(await json('GET', '/api/complaints?' + qs, undefined, authority));
    assert.equal(r.status, 400, qs);
    assert.ok(r.body.errors[field], qs);
  };
  await bad('search=' + 'q'.repeat(101), 'search');
  await bad('category=Nope', 'category');
  await bad('status=Closed', 'status');
  const ok = await read(await json('GET', '/api/complaints?search=%20%20streetlight%20%20&category=Streetlight', undefined, authority));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 1);
  const wildcard = await read(await json('GET', '/api/complaints?search=%25', undefined, authority));
  assert.equal(wildcard.body.length, 0, 'a literal % must not match everything');
  const byTitle = await read(await json('GET', '/api/complaints?search=trash', undefined, authority));
  assert.ok(byTitle.body.length >= 1);
});

// ---------------- Authority actions ----------------
test('status: transitions and remarks are enforced', async () => {
  const list = await read(await json('GET', '/api/complaints?category=Pothole', undefined, authority));
  const id = (await read(await json('GET', '/api/complaints?category=Streetlight', undefined, authority))).body[0].id;
  assert.ok(list.status === 200 && id);
  const patch = (body, token = authority, cid = id) => json('PATCH', `/api/complaints/${cid}/status`, body, token).then(read);

  let r = await patch({ status: 'Resolved', remark: 'Fixed on site by electrical team.' });
  assert.equal(r.status, 400); // Pending -> Resolved not allowed
  assert.ok(r.body.errors.status);
  r = await patch({ status: 'Bogus' });
  assert.ok(r.body.errors.status);
  r = await patch({ status: 'Rejected' });
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.remark, 'remark required when rejecting');
  r = await patch({ status: 'Rejected', remark: 'too short' });
  assert.ok(r.body.errors.remark);
  r = await patch({ status: 'Rejected', remark: 'r'.repeat(501) });
  assert.ok(r.body.errors.remark);
  r = await patch({ status: 'In Progress' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'In Progress');
  r = await patch({ status: 'Resolved' });
  assert.ok(r.body.errors.remark, 'remark required when resolving');
  r = await patch({ status: 'Resolved', remark: 'Replaced the bulb and tested <b>the</b> lamp.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.authorityRemark, 'Replaced the bulb and tested the lamp.');
  r = await patch({ status: 'In Progress' });
  assert.equal(r.status, 400, 'Resolved is final');
  r = await patch({ status: 'In Progress' }, citizen);
  assert.equal(r.status, 403);
  r = await patch({ status: 'In Progress' }, authority, 'not-a-uuid');
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.id);
  r = await patch({ status: 'In Progress' }, authority, '00000000-0000-4000-8000-000000000000');
  assert.equal(r.status, 404);
});

test('stats include rejected and match the data', async () => {
  const s = await read(await json('GET', '/api/stats', undefined, authority));
  assert.equal(s.status, 200);
  assert.equal(s.body.total, s.body.pending + s.body.inProgress + s.body.resolved + s.body.rejected);
  assert.equal(s.body.resolved, 1);
});

// ---------------- Session / sockets ----------------
test('logout revokes the JWT', async () => {
  const l = await read(await json('POST', '/api/auth/login', { email: 'citizen.one@gmail.com', password: 'Maple$River77' }));
  assert.equal(l.status, 200);
  const t = l.body.token;
  assert.equal((await read(await json('GET', '/api/auth/me', undefined, t))).status, 200);
  assert.equal((await read(await json('POST', '/api/auth/logout', {}, t))).status, 200);
  assert.equal((await read(await json('GET', '/api/auth/me', undefined, t))).status, 401);
});

test('socket.io pushes complaint:new and complaint:updated', async () => {
  const sock = ioClient(h.base, { transports: ['websocket'] });
  try {
    await new Promise(resolve => sock.on('connect', resolve));
    const events = [];
    sock.on('complaint:new', c => events.push(['new', c.id]));
    sock.on('complaint:updated', c => events.push(['updated', c.id, c.status]));
    const created = await post(complaintForm({ title: 'Water pipe burst nearby', description: 'A water pipe has burst and clean water is being wasted all over the road here.', lat: '17.7', lng: '78.7' }), citizen);
    assert.equal(created.status, 200);
    const upd = await json('PATCH', `/api/complaints/${created.body.id}/status`, { status: 'In Progress' }, authority);
    assert.equal(upd.status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(events, [['new', created.body.id], ['updated', created.body.id, 'In Progress']]);
  } finally {
    sock.close();
  }
});

test('malformed JSON and unknown API routes give clean JSON errors', async () => {
  const bad = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);
  const nf = await fetch(h.base + '/api/nope');
  assert.equal(nf.status, 404);
});
