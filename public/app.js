// App shell: session, routing between screens, live updates.
// (Part 2 ships login/signup + session handling; the citizen and authority screens arrive in Part 3.)
const { api, toast, setToken, getToken } = window.UI;

let currentUser = null; // { id, name, email, role }

const authView = document.getElementById('auth-view');
const appMain = document.getElementById('app-main');
const landing = document.getElementById('landing-view');
const userBar = document.getElementById('user-bar');
const userInfo = document.getElementById('user-info');

function home() {
  return currentUser && currentUser.role === 'authority' ? '#/dashboard' : '#/report';
}

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
  if (wantsAuth || hash === '#/') {
    location.replace(home());
    return;
  }
  showApp();
}

function showAuth(which) {
  document.body.classList.toggle('is-auth', true);
  appMain.classList.add('hidden');
  userBar.classList.add('hidden');
  if (!which) {
    authView.classList.add('hidden');
    return;
  }
  authView.classList.remove('hidden');
  landing && landing.classList.add('hidden');
  window.AuthUI.show(which);
  window.AuthUI.focusFirst(which);
}

function showApp() {
  document.body.classList.remove('is-auth');
  authView.classList.add('hidden');
  appMain.classList.remove('hidden');
  userBar.classList.remove('hidden');
  userInfo.textContent = `${currentUser.name} · ${currentUser.role}`;
  document.getElementById('stub-text').textContent = `Signed in as ${currentUser.name} (${currentUser.role}).`;
}

function onAuthenticated({ token, user }) {
  setToken(token);
  currentUser = user;
  toast(`Welcome, ${user.name.split(' ')[0]}!`, 'success');
  location.hash = home();
  route();
}

async function logout(silent) {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    // still clear the local session below
  }
  setToken(null);
  currentUser = null;
  if (!silent) toast('You have been logged out.', 'info');
  location.hash = '#/login';
  route();
}

window.UI.hooks.onUnauthorized = () => {
  if (!currentUser) return;
  setToken(null);
  currentUser = null;
  toast('Your session has expired. Please log in again.', 'error');
  location.hash = '#/login';
  route();
};

document.getElementById('logout-btn').addEventListener('click', () => logout());
window.addEventListener('hashchange', route);

window.AuthUI.init({ onAuthenticated });

(async function init() {
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
