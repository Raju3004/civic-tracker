// App shell: session, routing, navbar, citizen screens (report + my complaints), authority dashboard, live updates.
const { api, toast, setToken, getToken, escapeHtml, timeAgo, formatDateTime, confirmDialog, remarkDialog, createForm } = window.UI;
const R = window.CivicRules;

let currentUser = null; // { id, name, email, role }

const $ = id => document.getElementById(id);
const authView = $('auth-view');
const appMain = $('app-main');
const landing = $('landing-view');

const CATEGORY_ICON = { Pothole: '🚧', Garbage: '🗑️', Streetlight: '💡', 'Water Supply': '💧', Other: '📍' };
const STATUS_SLUG = { Pending: 'pending', 'In Progress': 'progress', Resolved: 'resolved', Rejected: 'rejected' };
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const safeUrl = u => (/^(https?:\/\/|data:image\/)/i.test(u || '') ? u : '');
const titleOf = c => c.title || (c.description.length > 60 ? c.description.slice(0, 57) + '…' : c.description);

// ---------------------------------------------------------------------------
// Routing + navbar
// ---------------------------------------------------------------------------
const ROUTES = {
  '#/report': { view: 'report-view', role: 'citizen', title: 'Report an issue' },
  '#/mine': { view: 'mine-view', role: 'citizen', title: 'My complaints' },
  '#/dashboard': { view: 'dashboard-view', role: 'authority', title: 'Dashboard' },
};
const NAV = {
  citizen: [['#/report', 'Report an issue'], ['#/mine', 'My complaints']],
  authority: [['#/dashboard', 'Dashboard']],
};
const home = () => (currentUser && currentUser.role === 'authority' ? '#/dashboard' : '#/report');

function route() {
  const hash = location.hash || '#/';
  const wantsAuth = hash === '#/login' || hash === '#/signup';

  if (!currentUser) {
    if (!wantsAuth) {
      // stay on the landing page until the visitor chooses
      if (landing && !landing.classList.contains('hidden')) return showAuth(null);
      location.replace('#/login');
      return;
    }
    return showAuth(hash === '#/signup' ? 'signup' : 'login');
  }
  const def = ROUTES[hash];
  if (!def || def.role !== currentUser.role) {
    location.replace(home());
    return;
  }
  showApp(hash, def);
}

function showAuth(which) {
  document.body.classList.add('is-auth');
  appMain.classList.add('hidden');
  closeNavMenu();
  disconnectSocket();
  if (!which) {
    authView.classList.add('hidden');
    return;
  }
  authView.classList.remove('hidden');
  landing && landing.classList.add('hidden');
  window.AuthUI.show(which);
  window.AuthUI.focusFirst(which);
}

function showApp(hash, def) {
  document.body.classList.remove('is-auth');
  authView.classList.add('hidden');
  appMain.classList.remove('hidden');
  renderNav(hash);
  document.querySelectorAll('#app-main .view').forEach(v => (v.hidden = v.id !== def.view));
  document.title = `${def.title} — CivicTrack`;
  window.scrollTo(0, 0);
  closeNavMenu();
  connectSocket();
  if (def.view === 'report-view') enterReport();
  if (def.view === 'mine-view') loadMine();
  if (def.view === 'dashboard-view') enterDashboard();
}

function renderNav(activeHash) {
  const u = currentUser;
  $('user-name').textContent = u.name;
  $('user-role').textContent = u.role;
  $('nav-avatar').textContent = u.name.trim().charAt(0).toUpperCase();
  $('nav-links').innerHTML = NAV[u.role]
    .map(([href, label]) => `<li><a class="nav-link${href === activeHash ? ' active' : ''}" href="${href}"${href === activeHash ? ' aria-current="page"' : ''}>${label}</a></li>`)
    .join('');
}

// Mobile menu
const navToggle = $('nav-toggle');
function setNavMenu(open) {
  document.body.classList.toggle('nav-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
const closeNavMenu = () => setNavMenu(false);
navToggle.addEventListener('click', () => setNavMenu(!document.body.classList.contains('nav-open')));
$('nav-menu').addEventListener('click', e => e.target.closest('a') && closeNavMenu());
document.addEventListener('keydown', e => e.key === 'Escape' && closeNavMenu());
window.matchMedia('(min-width: 861px)').addEventListener('change', closeNavMenu);

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------
function onAuthenticated({ token, user }) {
  setToken(token);
  currentUser = user;
  toast(`Welcome, ${user.name.split(' ')[0]}!`, 'success');
  mineLoaded = false;
  dashLoaded = false;
  location.hash = home();
  route();
}

async function logout() {
  if (currentUser && currentUser.role === 'citizen' && reportDirty()) {
    const ok = await confirmDialog({
      title: 'Discard your report?',
      message: 'You have a complaint you have not submitted yet. Logging out will discard it.',
      confirmText: 'Log out and discard',
      cancelText: 'Keep editing',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    // still clear the local session below
  }
  endSession();
  toast('You have been logged out.', 'info');
}

function endSession() {
  setToken(null);
  currentUser = null;
  resetReport();
  lastDashboard = [];
  mineLoaded = false;
  dashLoaded = false;
  location.hash = '#/login';
  route();
}

window.UI.hooks.onUnauthorized = () => {
  if (!currentUser) return;
  endSession();
  toast('Your session has expired. Please log in again.', 'error');
};

$('logout-btn').addEventListener('click', logout);
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Real-time updates (Socket.io)
// ---------------------------------------------------------------------------
let socket = null;
function setLive(state) {
  const el = $('live-indicator');
  el.dataset.state = state;
  $('live-text').textContent = state === 'on' ? 'Live' : 'Reconnecting…';
}

function connectSocket() {
  if (socket || typeof io === 'undefined') return;
  socket = io();
  socket.on('connect', () => setLive('on'));
  socket.on('disconnect', () => setLive('off'));
  socket.on('complaint:new', c => {
    if (!currentUser) return;
    if (currentUser.role === 'authority') {
      toast(`New complaint: ${titleOf(c)}`, 'info');
      refreshSoon();
    } else if (mineLoaded) loadMine();
  });
  socket.on('complaint:updated', c => {
    if (!currentUser) return;
    if (currentUser.role === 'authority') refreshSoon();
    else {
      if (c.submittedBy === currentUser.id) toast(`Your complaint "${titleOf(c)}" is now ${c.status}.`, 'info');
      if (mineLoaded) loadMine();
    }
  });
}
function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (currentUser && currentUser.role === 'authority' && !$('dashboard-view').hidden) loadDashboard();
  }, 200);
}

// ---------------------------------------------------------------------------
// Shared components: complaint card, skeletons, empty + error states
// ---------------------------------------------------------------------------
function statusBadge(status) {
  return `<span class="badge badge-${STATUS_SLUG[status] || 'pending'}">${escapeHtml(status)}</span>`;
}

function locationText(c) {
  if (c.address) return escapeHtml(c.address);
  if (c.lat == null || c.lng == null) return 'No location';
  const acc = c.accuracyMeters ? ` (±${Math.round(c.accuracyMeters)} m)` : '';
  return `${Number(c.lat).toFixed(4)}, ${Number(c.lng).toFixed(4)}${acc}`;
}

function actionButtons(c) {
  const next = R.nextStatuses(c.status);
  if (!next.length) return '<span class="closed-note">Closed</span>';
  const btn = {
    'In Progress': `<button type="button" class="btn btn-outline btn-sm" data-action="In Progress" data-id="${c.id}">Start work</button>`,
    Resolved: `<button type="button" class="btn btn-accent btn-sm" data-action="Resolved" data-id="${c.id}">Mark resolved</button>`,
    Rejected: `<button type="button" class="btn btn-outline-danger btn-sm" data-action="Rejected" data-id="${c.id}">Reject</button>`,
  };
  return next.map(s => btn[s]).join('');
}

function complaintCard(c, { authority = false } = {}) {
  const photo = safeUrl(c.photoUrl);
  const extra = (c.photoUrls || []).length > 1 ? `<span class="thumb-count">+${c.photoUrls.length - 1}</span>` : '';
  const thumb = photo
    ? `<a class="c-thumb" data-icon="${CATEGORY_ICON[c.category] || '📍'}" href="${escapeHtml(photo)}" target="_blank" rel="noopener" aria-label="Open photo evidence"><img src="${escapeHtml(photo)}" alt="Photo evidence for ${escapeHtml(titleOf(c))}" loading="lazy">${extra}</a>`
    : `<div class="c-thumb c-thumb-empty" aria-hidden="true">${CATEGORY_ICON[c.category] || '📍'}</div>`;
  const dup = c.isDuplicateOf ? '<span class="tag tag-dup">Possible duplicate</span>' : '';
  const remark = c.authorityRemark
    ? `<p class="c-remark"><strong>Authority remark:</strong> ${escapeHtml(c.authorityRemark)}</p>`
    : '';
  const by = authority && c.submittedByName ? ` · by ${escapeHtml(c.submittedByName)}` : '';
  return `
  <article class="c-card" data-status="${STATUS_SLUG[c.status] || 'pending'}">
    ${thumb}
    <div class="c-body">
      <h3 class="c-title">${escapeHtml(titleOf(c))}</h3>
      <div class="c-tags">${statusBadge(c.status)}<span class="tag">${CATEGORY_ICON[c.category] || ''} ${escapeHtml(c.category)}</span>${dup}</div>
      <p class="c-desc">${escapeHtml(c.description)}</p>
      <p class="c-meta"><time datetime="${escapeHtml(c.createdAt)}" title="${escapeHtml(formatDateTime(c.createdAt))}">${timeAgo(c.createdAt)}</time> · ${locationText(c)}${by}</p>
      ${remark}
    </div>
    ${authority ? `<div class="c-actions">${actionButtons(c)}</div>` : ''}
  </article>`;
}

// A photo that fails to load falls back to the category icon instead of a blank box
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.c-thumb')) return;
  const thumb = img.closest('.c-thumb');
  thumb.classList.add('c-thumb-empty');
  thumb.textContent = thumb.dataset.icon || '📍';
}, true);

const skeletonCards = n =>
  Array.from({ length: n }, () => `
  <div class="c-card skeleton-card" aria-hidden="true">
    <div class="c-thumb skeleton"></div>
    <div class="c-body"><div class="skeleton sk-line w60"></div><div class="skeleton sk-line w30"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line w80"></div></div>
  </div>`).join('');

const ICON_INBOX = '<svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 28l5-16a3 3 0 012.9-2h20.2a3 3 0 012.9 2l5 16v8a3 3 0 01-3 3H9a3 3 0 01-3-3z"/><path d="M6 28h10a4 4 0 004 4h8a4 4 0 004-4h10"/></svg>';
const ICON_ALERT = '<svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="24" cy="24" r="18"/><path d="M24 14v12M24 32v.5"/></svg>';

const emptyState = ({ title, message, cta = '' }) =>
  `<div class="state"><div class="state-icon">${ICON_INBOX}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>${cta}</div>`;
const errorState = message =>
  `<div class="state state-error" role="alert"><div class="state-icon">${ICON_ALERT}</div><h3>We couldn't load this</h3><p>${escapeHtml(message || 'Something went wrong.')}</p><button type="button" class="btn btn-outline btn-sm" data-retry>Try again</button></div>`;

// ---------------------------------------------------------------------------
// Citizen: my complaints
// ---------------------------------------------------------------------------
let mineLoaded = false;
async function loadMine() {
  const el = $('my-complaints-list');
  if (!mineLoaded) el.innerHTML = skeletonCards(3);
  try {
    const items = await api('/api/complaints/mine');
    mineLoaded = true;
    const open = items.filter(c => c.status === 'Pending' || c.status === 'In Progress').length;
    $('mine-summary').textContent = items.length
      ? `${items.length} reported · ${open} still open`
      : 'Track every issue you have reported.';
    el.innerHTML = items.length
      ? items.map(c => complaintCard(c)).join('')
      : emptyState({
          title: 'No complaints yet',
          message: 'When you report an issue it will show up here, with live status updates.',
          cta: '<a class="btn btn-accent" href="#/report">Report your first issue</a>',
        });
  } catch (err) {
    el.innerHTML = errorState(err.message);
  }
}
$('my-complaints-list').addEventListener('click', e => e.target.closest('[data-retry]') && loadMine());

// ---------------------------------------------------------------------------
// Citizen: report form (title, category, description, location picker, photos)
// ---------------------------------------------------------------------------
let loc = null; // { lat, lng, accuracy }
let photos = []; // { id, file, url }
let photoSeq = 0;
let locMap = null;
let locMarker = null;
let locCircle = null;

const reportEl = $('complaint-form');
const reportForm = createForm({
  form: reportEl,
  alias: { lat: 'location', lng: 'location', accuracy: 'location' },
  values: () => ({
    title: reportEl.elements.title.value,
    category: reportEl.elements.category.value,
    description: reportEl.elements.description.value,
    address: reportEl.elements.address.value,
    lat: loc ? String(loc.lat) : '',
    lng: loc ? String(loc.lng) : '',
    accuracy: loc && loc.accuracy != null ? String(loc.accuracy) : '',
  }),
  validate: R.validateComplaintForm,
  submit: async v => {
    const fd = new FormData();
    fd.append('title', v.title.trim());
    fd.append('category', v.category);
    fd.append('description', v.description.trim());
    if (v.address.trim()) fd.append('address', v.address.trim());
    fd.append('lat', v.lat);
    fd.append('lng', v.lng);
    if (v.accuracy) fd.append('accuracy', v.accuracy);
    photos.forEach(p => fd.append('photos', p.file, p.file.name));

    const data = await api('/api/complaints', { method: 'POST', form: fd });
    toast(
      data.isDuplicateOf
        ? 'Submitted — flagged as a possible duplicate of an existing report nearby.'
        : `Complaint submitted (category: ${data.category}).`,
      data.isDuplicateOf ? 'info' : 'success'
    );
    resetReport();
    mineLoaded = false;
    location.hash = '#/mine';
  },
});

function reportDirty() {
  const f = reportEl.elements;
  return Boolean(f.title.value.trim() || f.description.value.trim() || f.address.value.trim() || loc || photos.length);
}

function updateCounters() {
  reportEl.querySelectorAll('.counter[data-counter-for]').forEach(c => {
    const len = reportEl.elements[c.dataset.counterFor].value.length;
    const max = Number(c.dataset.max);
    const min = Number(c.dataset.min || 0);
    c.textContent = `${len} / ${max}` + (min && len < min ? ` (min ${min})` : '');
    c.classList.toggle('over', len >= max);
  });
}
reportEl.addEventListener('input', updateCounters);

function resetReport() {
  reportForm.reset();
  photos.forEach(p => URL.revokeObjectURL(p.url));
  photos = [];
  renderPreviews();
  clearLocation();
  updateCounters();
}
$('clear-report').addEventListener('click', async () => {
  if (reportDirty()) {
    const ok = await confirmDialog({
      title: 'Clear the form?',
      message: 'Everything you entered, including the location and photos, will be removed.',
      confirmText: 'Clear form',
      cancelText: 'Keep editing',
      danger: true,
    });
    if (!ok) return;
  }
  resetReport();
});

// ---- Location picker ----
function enterReport() {
  ensureLocationMap();
  setTimeout(() => locMap && locMap.invalidateSize(), 60);
  const first = reportEl.elements.title;
  if (first && !reportDirty()) first.focus({ preventScroll: true });
}

function ensureLocationMap() {
  if (locMap) return;
  const mapEl = $('location-map');
  if (!window.L) {
    mapEl.innerHTML = '<div class="map-fallback">The map could not be loaded. Check your connection, or use “Use my current location”.</div>';
    return;
  }
  locMap = L.map('location-map').setView([17.385, 78.4867], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(locMap);
  locMap.on('click', e => setLocation(e.latlng.lat, e.latlng.lng, null, 'Pin placed'));
}

function setLocation(lat, lng, accuracy, how, { zoom = false } = {}) {
  loc = { lat, lng, accuracy };
  const status = $('location-status');
  const acc = accuracy != null ? ` (accuracy ±${Math.round(accuracy)} m)` : '';
  status.textContent = `${how}: ${lat.toFixed(5)}, ${lng.toFixed(5)}${acc}`;
  status.classList.add('is-set');
  if (locMap) {
    if (!locMarker) {
      locMarker = L.marker([lat, lng], { draggable: true, title: 'Issue location' }).addTo(locMap);
      locMarker.on('dragend', () => {
        const p = locMarker.getLatLng();
        setLocation(p.lat, p.lng, null, 'Pin moved');
      });
    } else locMarker.setLatLng([lat, lng]);
    if (locCircle) {
      locMap.removeLayer(locCircle);
      locCircle = null;
    }
    if (accuracy != null) locCircle = L.circle([lat, lng], { radius: accuracy, color: cssVar('--primary-700'), weight: 1, fillOpacity: 0.1 }).addTo(locMap);
    if (zoom) locMap.setView([lat, lng], 17);
  }
  reportForm.render();
}

function clearLocation() {
  loc = null;
  const status = $('location-status');
  status.textContent = 'No location chosen yet.';
  status.classList.remove('is-set');
  if (locMap) {
    if (locMarker) locMap.removeLayer(locMarker);
    if (locCircle) locMap.removeLayer(locCircle);
    locMarker = locCircle = null;
    locMap.setView([17.385, 78.4867], 12);
  }
}

$('locate-btn').addEventListener('click', () => {
  const btn = $('locate-btn');
  if (!navigator.geolocation) {
    toast('Your browser does not support location. Click the map to set the pin instead.', 'error');
    return;
  }
  const previous = $('location-status').textContent;
  btn.disabled = true;
  btn.classList.add('is-loading');
  $('location-status').textContent = 'Locating (requesting best GPS accuracy)…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      const { latitude, longitude, accuracy } = pos.coords;
      setLocation(latitude, longitude, accuracy, 'Captured', { zoom: true });
    },
    () => {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      $('location-status').textContent = previous;
      toast('Could not get your GPS location. Click the map to place the pin manually.', 'error');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// ---- Photos: previews, removal, type/size checks (type verified from the file's first bytes) ----
const photoInput = $('c-photos');
const dropzone = $('dropzone');

async function addFiles(fileList) {
  let problem = '';
  for (const file of Array.from(fileList)) {
    if (photos.length >= R.IMAGE.maxFiles) {
      problem = `You can upload at most ${R.IMAGE.maxFiles} photos.`;
      break;
    }
    const metaError = R.validateImageMeta({ name: file.name, type: file.type, size: file.size });
    if (metaError) {
      problem = metaError;
      continue;
    }
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!R.sniffImageType(head)) {
      problem = `${file.name}: file content is not a valid JPG, PNG or WEBP image.`;
      continue;
    }
    if (photos.some(p => p.file.name === file.name && p.file.size === file.size)) continue;
    photos.push({ id: ++photoSeq, file, url: URL.createObjectURL(file) });
  }
  renderPreviews();
  // skipped files are explained under the photo field, but don't stop the complaint from being submitted
  reportForm.notice('photos', problem);
}

function renderPreviews() {
  $('photo-previews').innerHTML = photos
    .map(p => `
    <li class="preview">
      <img src="${p.url}" alt="">
      <div class="preview-info"><span class="preview-name">${escapeHtml(p.file.name)}</span><span class="hint">${(p.file.size / 1024 / 1024).toFixed(2)} MB</span></div>
      <button type="button" class="preview-remove" data-remove="${p.id}" aria-label="Remove photo ${escapeHtml(p.file.name)}">&times;</button>
    </li>`)
    .join('');
}

$('photo-previews').addEventListener('click', e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const idx = photos.findIndex(p => p.id === Number(btn.dataset.remove));
  if (idx === -1) return;
  URL.revokeObjectURL(photos[idx].url);
  photos.splice(idx, 1);
  renderPreviews();
  reportForm.notice('photos', '');
  (document.querySelector('#photo-previews .preview-remove') || photoInput).focus();
});

photoInput.addEventListener('change', () => {
  addFiles(photoInput.files);
  photoInput.value = '';
});
['dragenter', 'dragover'].forEach(t => dropzone.addEventListener(t, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => dropzone.addEventListener(t, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => addFiles(e.dataTransfer.files));

// ---------------------------------------------------------------------------
// Authority: dashboard (stats, filters, list, map, status actions)
// ---------------------------------------------------------------------------
let map = null;
let markersLayer = null;
let lastDashboard = [];
let dashSeq = 0;
let dashLoaded = false;

function enterDashboard() {
  setLive(socket && socket.connected ? 'on' : 'off');
  if (!dashLoaded) {
    $('stats-row').innerHTML = statCards(null);
    $('complaint-list').innerHTML = skeletonCards(4);
  }
  loadDashboard();
  setTimeout(() => map && map.invalidateSize(), 60);
}

function statCards(s) {
  const cards = [
    ['total', 'Total', 'total'],
    ['pending', 'Pending', 'pending'],
    ['inProgress', 'In Progress', 'progress'],
    ['resolved', 'Resolved', 'resolved'],
    ['rejected', 'Rejected', 'rejected'],
  ];
  return cards
    .map(([key, label, slug]) => `<div class="stat-card stat-${slug}${s ? '' : ' is-loading'}"><span class="stat-label">${label}</span><span class="stat-num">${s ? s[key] : '–'}</span></div>`)
    .join('');
}

function currentFilters() {
  return {
    search: $('filter-search').value.trim(),
    category: $('filter-category').value,
    status: $('filter-status').value,
  };
}

async function loadDashboard() {
  const seq = ++dashSeq;
  const filters = currentFilters();
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
  const qs = params.toString();
  $('filter-clear').hidden = !qs;

  const [statsRes, listRes] = await Promise.allSettled([
    api('/api/stats'),
    api('/api/complaints' + (qs ? '?' + qs : '')),
  ]);
  if (seq !== dashSeq) return; // a newer request superseded this one

  $('stats-row').innerHTML = statCards(statsRes.status === 'fulfilled' ? statsRes.value : null);
  const listEl = $('complaint-list');
  if (listRes.status === 'rejected') {
    listEl.innerHTML = errorState(listRes.reason.message);
    $('list-count').textContent = '';
    return;
  }
  dashLoaded = true;
  const items = listRes.value;
  lastDashboard = items;
  const total = statsRes.status === 'fulfilled' ? statsRes.value.total : items.length;
  $('list-count').textContent = qs ? `Showing ${items.length} of ${total}` : `${items.length} total`;
  listEl.innerHTML = items.length
    ? items.map(c => complaintCard(c, { authority: true })).join('')
    : qs
      ? emptyState({ title: 'No matching complaints', message: 'Try a different search or clear the filters.' })
      : emptyState({ title: 'No complaints yet', message: 'New reports will appear here the moment citizens submit them.' });
  renderMap(items);
}

let filterDebounce;
['filter-search', 'filter-category', 'filter-status'].forEach(id => {
  $(id).addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => {
      const errors = R.validateFilters(currentFilters());
      if (Object.keys(errors).length) return toast(Object.values(errors)[0], 'error');
      loadDashboard();
    }, 300);
  });
});
$('filter-clear').addEventListener('click', () => {
  $('filter-search').value = '';
  $('filter-category').value = '';
  $('filter-status').value = '';
  loadDashboard();
  $('filter-search').focus();
});

// Status actions: Start work / Mark resolved / Reject (the last two need a remark)
$('complaint-list').addEventListener('click', async e => {
  if (e.target.closest('[data-retry]')) return loadDashboard();
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { id, action } = btn.dataset;
  const c = lastDashboard.find(x => x.id === id);
  if (!c) return;

  let remark;
  if (R.REMARK_REQUIRED_FOR.includes(action)) {
    remark = await remarkDialog({
      title: action === 'Resolved' ? 'Mark as resolved' : 'Reject this complaint',
      message: `“${titleOf(c)}” — the citizen will see your remark.`,
      confirmText: action === 'Resolved' ? 'Mark resolved' : 'Reject complaint',
      danger: action === 'Rejected',
    });
    if (remark === null) return;
  }

  const buttons = btn.closest('.c-actions').querySelectorAll('button');
  buttons.forEach(b => (b.disabled = true));
  btn.classList.add('is-loading');
  try {
    await api(`/api/complaints/${id}/status`, { method: 'PATCH', json: { status: action, remark } });
    toast(`Marked as ${action}.`, 'success');
    loadDashboard();
  } catch (err) {
    const first = err.errors ? Object.values(err.errors)[0] : err.message;
    toast(first, 'error');
    buttons.forEach(b => (b.disabled = false));
    btn.classList.remove('is-loading');
    if (err.status === 409 || err.status === 404) loadDashboard();
  }
});

function renderMap(complaints) {
  const mapEl = $('map');
  if (!window.L) {
    mapEl.innerHTML = '<div class="map-fallback">The map could not be loaded. Check your connection.</div>';
    return;
  }
  const withLocation = complaints.filter(c => c.lat != null && c.lng != null);
  if (!map) {
    map = L.map('map').setView(withLocation.length ? [withLocation[0].lat, withLocation[0].lng] : [17.385, 78.4867], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }
  markersLayer.clearLayers();
  const colors = {
    Pending: cssVar('--status-pending'),
    'In Progress': cssVar('--status-progress'),
    Resolved: cssVar('--status-resolved'),
    Rejected: cssVar('--status-rejected'),
  };
  withLocation.forEach(c => {
    L.circleMarker([c.lat, c.lng], {
      radius: 9,
      color: '#fff',
      weight: 2,
      fillColor: colors[c.status] || '#999',
      fillOpacity: 0.95,
    })
      .bindPopup(`<b>${escapeHtml(titleOf(c))}</b><br>${escapeHtml(c.category)} · ${escapeHtml(c.status)}`)
      .addTo(markersLayer);
  });
  if (withLocation.length > 1) map.fitBounds(withLocation.map(c => [c.lat, c.lng]), { padding: [28, 28], maxZoom: 15 });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.AuthUI.init({ onAuthenticated });

(async function init() {
  updateCounters();
  if (getToken()) {
    try {
      const data = await api('/api/auth/me');
      currentUser = data.user;
    } catch (err) {
      setToken(null);
      currentUser = null;
    }
  }
  route();
})();
