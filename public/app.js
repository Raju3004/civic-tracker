const API = '/api/complaints';
let currentUser = null; // { id, name, email, role }

// ---- Elements ----
const authView = document.getElementById('auth-view');
const citizenView = document.getElementById('citizen-view');
const authorityView = document.getElementById('authority-view');
const userBar = document.getElementById('user-bar');
const userInfo = document.getElementById('user-info');

function authHeaders() {
  const token = localStorage.getItem('civictrack_token');
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// ---- View switching based on auth state + role ----
function showView(name) {
  [authView, citizenView, authorityView].forEach(v => v.classList.add('hidden'));
  if (name === 'auth') authView.classList.remove('hidden');
  if (name === 'citizen') citizenView.classList.remove('hidden');
  if (name === 'authority') {
    authorityView.classList.remove('hidden');
    loadDashboard();
  }
}

function applyAuthState() {
  if (!currentUser) {
    userBar.classList.add('hidden');
    disconnectSocket();
    showView('auth');
    return;
  }
  userBar.classList.remove('hidden');
  userInfo.textContent = `${currentUser.name} · ${currentUser.role}`;
  connectSocket();
  showView(currentUser.role === 'authority' ? 'authority' : 'citizen');
  if (currentUser.role === 'citizen') loadMyComplaints();
}

// ---- Real-time updates via Socket.io ----
let socket = null;
function connectSocket() {
  if (socket) return;
  socket = io();
  socket.on('complaint:new', () => {
    if (currentUser?.role === 'authority') loadDashboard();
    if (currentUser?.role === 'citizen') loadMyComplaints();
  });
  socket.on('complaint:updated', () => {
    if (currentUser?.role === 'authority') loadDashboard();
    if (currentUser?.role === 'citizen') loadMyComplaints();
  });
}
function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// ---- Restore session on load ----
(async function init() {
  const token = localStorage.getItem('civictrack_token');
  if (!token) return applyAuthState();
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (!res.ok) throw new Error('invalid session');
    const data = await res.json();
    currentUser = data.user;
  } catch (err) {
    localStorage.removeItem('civictrack_token');
    currentUser = null;
  }
  applyAuthState();
})();

// ---- Auth tab switching ----
document.getElementById('tab-login').addEventListener('click', () => switchAuthTab('login'));
document.getElementById('tab-signup').addEventListener('click', () => switchAuthTab('signup'));

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-signup').classList.toggle('active', !isLogin);
  document.getElementById('login-form').classList.toggle('hidden', !isLogin);
  document.getElementById('signup-form').classList.toggle('hidden', isLogin);
}

// ---- Login ----
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Could not log in.';
      return;
    }
    localStorage.setItem('civictrack_token', data.token);
    currentUser = data.user;
    applyAuthState();
  } catch (err) {
    errorEl.textContent = 'Something went wrong. Is the server running?';
  }
});

// ---- Signup ----
document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errorEl = document.getElementById('signup-error');
  errorEl.textContent = '';
  const name = document.getElementById('signup-name').value;
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;
  const role = document.getElementById('signup-role').value;

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Could not sign up.';
      return;
    }
    localStorage.setItem('civictrack_token', data.token);
    currentUser = data.user;
    applyAuthState();
  } catch (err) {
    errorEl.textContent = 'Something went wrong. Is the server running?';
  }
});

// ---- Logout ----
document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  } catch (err) {
    // even if the network call fails, still clear the local session below
  }
  localStorage.removeItem('civictrack_token');
  currentUser = null;
  applyAuthState();
});

// ---- Geolocation with correctable map pin ----
let capturedLat = null;
let capturedLng = null;
let capturedAccuracy = null;
let locationMap, locationMarker, accuracyCircle;

function setCapturedLocation(lat, lng, accuracy, statusPrefix) {
  capturedLat = lat;
  capturedLng = lng;
  capturedAccuracy = accuracy;
  const status = document.getElementById('location-status');
  const accuracyText = accuracy != null ? ` (accuracy: ±${Math.round(accuracy)}m)` : '';
  status.textContent = `${statusPrefix}: ${lat.toFixed(5)}, ${lng.toFixed(5)}${accuracyText}`;
}

function ensureLocationMap(lat, lng, accuracy) {
  const mapEl = document.getElementById('location-map');
  mapEl.classList.remove('hidden');

  if (!locationMap) {
    locationMap = L.map('location-map').setView([lat, lng], 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(locationMap);

    locationMarker = L.marker([lat, lng], { draggable: true }).addTo(locationMap);
    locationMarker.on('dragend', () => {
      const pos = locationMarker.getLatLng();
      setCapturedLocation(pos.lat, pos.lng, null, 'Adjusted manually');
      if (accuracyCircle) locationMap.removeLayer(accuracyCircle);
    });

    locationMap.on('click', e => {
      locationMarker.setLatLng(e.latlng);
      setCapturedLocation(e.latlng.lat, e.latlng.lng, null, 'Adjusted manually');
      if (accuracyCircle) locationMap.removeLayer(accuracyCircle);
    });

    // Leaflet needs a nudge to size correctly inside a freshly-unhidden container
    setTimeout(() => locationMap.invalidateSize(), 100);
  } else {
    locationMap.setView([lat, lng], 17);
    locationMarker.setLatLng([lat, lng]);
  }

  if (accuracyCircle) locationMap.removeLayer(accuracyCircle);
  if (accuracy != null) {
    accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#2C5F7C', fillOpacity: 0.1 }).addTo(
      locationMap
    );
  }
}

document.getElementById('locate-btn').addEventListener('click', () => {
  const status = document.getElementById('location-status');
  if (!navigator.geolocation) {
    status.textContent = 'Geolocation not supported by this browser';
    return;
  }
  status.textContent = 'Locating (requesting best GPS accuracy)...';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      setCapturedLocation(latitude, longitude, accuracy, 'Captured');
      ensureLocationMap(latitude, longitude, accuracy);
    },
    () => {
      status.textContent = 'Could not get GPS location — click the map below to set it manually.';
      ensureLocationMap(17.385, 78.4867, null);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// ---- Submit complaint ----
document.getElementById('complaint-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);
  if (capturedLat != null) {
    formData.append('lat', capturedLat);
    formData.append('lng', capturedLng);
    if (capturedAccuracy != null) formData.append('accuracy', capturedAccuracy);
  }

  const resultEl = document.getElementById('submit-result');
  resultEl.textContent = 'Submitting...';

  try {
    const res = await fetch(API, { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    if (!res.ok) {
      resultEl.textContent = data.error || 'Could not submit complaint.';
      return;
    }
    if (data.isDuplicateOf) {
      resultEl.innerHTML =
        '<span class="dup-msg">Submitted — flagged as a possible duplicate of an existing report nearby.</span>';
    } else {
      resultEl.innerHTML = `<span class="success-msg">Complaint submitted successfully (category: ${data.category}).</span>`;
    }
    form.reset();
    capturedLat = null;
    capturedLng = null;
    capturedAccuracy = null;
    document.getElementById('location-status').textContent = 'No location captured yet';
    document.getElementById('location-map').classList.add('hidden');
    loadMyComplaints();
  } catch (err) {
    resultEl.textContent = 'Something went wrong submitting the complaint.';
  }
});

// ---- Citizen: my submitted complaints ----
async function loadMyComplaints() {
  try {
    const res = await fetch('/api/complaints/mine', { headers: authHeaders() });
    if (!res.ok) return;
    const complaints = await res.json();
    renderMyComplaints(complaints);
  } catch (err) {
    // silent — this is a convenience view, not critical path
  }
}

function renderMyComplaints(complaints) {
  const el = document.getElementById('my-complaints-list');
  if (!complaints.length) {
    el.innerHTML = '<p style="color:#5B6B7A;font-size:13px;">You haven\'t submitted any complaints yet.</p>';
    return;
  }
  el.innerHTML = complaints
    .map(
      c => `
    <div class="complaint-card status-${c.status.toLowerCase().replace(' ', '-')}">
      ${c.isDuplicateOf ? '<span class="dup-tag">DUPLICATE</span>' : ''}
      <div class="cat">${c.category}</div>
      <div class="desc">${escapeHtml(c.description)}</div>
      <div class="meta">${new Date(c.createdAt).toLocaleString()} · Status: ${c.status}</div>
    </div>
  `
    )
    .join('');
}

// ---- Authority dashboard ----
let map, markersLayer;

function currentFilters() {
  const search = document.getElementById('filter-search').value.trim();
  const category = document.getElementById('filter-category').value;
  const status = document.getElementById('filter-status').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  return params.toString();
}

async function loadDashboard() {
  const qs = currentFilters();
  const [stats, complaints] = await Promise.all([
    fetch('/api/stats', { headers: authHeaders() }).then(r => r.json()),
    fetch(`${API}${qs ? '?' + qs : ''}`, { headers: authHeaders() }).then(r => r.json()),
  ]);
  renderStats(stats);
  renderComplaintList(complaints);
  renderMap(complaints);
}

let filterDebounce;
['filter-search', 'filter-category', 'filter-status'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(loadDashboard, 300);
  });
});

function renderStats(stats) {
  const el = document.getElementById('stats-row');
  el.innerHTML = `
    <div class="stat-card"><div class="num">${stats.total}</div><div class="label">Total</div></div>
    <div class="stat-card"><div class="num">${stats.pending}</div><div class="label">Pending</div></div>
    <div class="stat-card"><div class="num">${stats.inProgress}</div><div class="label">In Progress</div></div>
    <div class="stat-card"><div class="num">${stats.resolved}</div><div class="label">Resolved</div></div>
  `;
}

function renderComplaintList(complaints) {
  const el = document.getElementById('complaint-list');
  if (!complaints.length) {
    el.innerHTML = '<p style="color:#5B6B7A;font-size:13px;">No complaints submitted yet.</p>';
    return;
  }
  el.innerHTML = complaints
    .map(
      c => `
    <div class="complaint-card status-${c.status.toLowerCase().replace(' ', '-')}">
      ${c.isDuplicateOf ? '<span class="dup-tag">DUPLICATE</span>' : ''}
      ${c.photoUrl ? `<img src="${c.photoUrl}" alt="Photo evidence" class="complaint-photo">` : ''}
      <div class="cat">${c.category}</div>
      <div class="desc">${escapeHtml(c.description)}</div>
      <div class="meta">${c.lat ? c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) : 'No location'}${
        c.accuracyMeters ? ' (±' + Math.round(c.accuracyMeters) + 'm)' : ''
      } · ${new Date(c.createdAt).toLocaleString()}${
        c.submittedByName ? ' · by ' + escapeHtml(c.submittedByName) : ''
      }</div>
      <select class="status-select" data-id="${c.id}">
        <option ${c.status === 'Pending' ? 'selected' : ''}>Pending</option>
        <option ${c.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
        <option ${c.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
      </select>
    </div>
  `
    )
    .join('');

  el.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      await fetch(`${API}/${e.target.dataset.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status: e.target.value }),
      });
      loadDashboard();
    });
  });
}

function renderMap(complaints) {
  const withLocation = complaints.filter(c => c.lat && c.lng);
  if (!map) {
    map = L.map('map').setView(
      withLocation.length ? [withLocation[0].lat, withLocation[0].lng] : [17.385, 78.4867],
      13
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }
  markersLayer.clearLayers();
  const colors = { Pending: '#E8A33D', 'In Progress': '#2C5F7C', Resolved: '#4C9A6A' };
  withLocation.forEach(c => {
    L.circleMarker([c.lat, c.lng], {
      radius: 8,
      color: colors[c.status] || '#999',
      fillColor: colors[c.status] || '#999',
      fillOpacity: 0.8,
    })
      .bindPopup(`<b>${c.category}</b><br>${escapeHtml(c.description)}<br>${c.status}`)
      .addTo(markersLayer);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
