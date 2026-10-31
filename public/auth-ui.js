// Login and signup screens. Validation rules come from shared/rules.js (window.CivicRules).
window.AuthUI = (function () {
  const R = window.CivicRules;
  const { api, createForm, initPasswordToggles } = window.UI;

  function init({ onAuthenticated }) {
    initPasswordToggles(document.getElementById('auth-view'));
    initLogin(onAuthenticated);
    initSignup(onAuthenticated);
  }

  function initLogin(onAuthenticated) {
    const form = createForm({
      form: document.getElementById('login-form'),
      validate: R.validateLoginForm,
      submit: async values => {
        try {
          const data = await api('/api/auth/login', {
            method: 'POST',
            auth: false,
            json: { email: values.email.trim(), password: values.password },
          });
          onAuthenticated(data);
        } catch (err) {
          // Never say which of the two was wrong
          if (err.status === 401) err.message = 'Invalid email or password';
          throw err;
        }
      },
    });
    return form;
  }

  function initSignup(onAuthenticated) {
    const el = document.getElementById('signup-form');
    const meter = el.querySelector('.strength');
    const meterLabel = el.querySelector('.strength-label');
    const checklist = el.querySelector('.pw-checklist');

    const form = createForm({
      form: el,
      validate: R.validateSignupForm,
      submit: async values => {
        const data = await api('/api/auth/signup', {
          method: 'POST',
          auth: false,
          json: {
            name: values.name.trim(),
            email: values.email.trim(),
            mobile: values.mobile.trim(),
            role: values.role,
            password: values.password,
            confirmPassword: values.confirmPassword,
          },
        });
        onAuthenticated(data);
      },
    });

    function renderStrength() {
      const v = form.values();
      const ctx = { name: v.name, email: v.email };
      const checks = R.passwordChecks(v.password, ctx);
      const { score, label } = R.passwordStrength(v.password, ctx);
      meter.dataset.level = String(score);
      meter.dataset.name = label ? label.toLowerCase() : '';
      meterLabel.textContent = label ? `Password strength: ${label}` : 'Password strength';
      checklist.innerHTML = checks
        .map(c => `<li class="${c.ok ? 'met' : ''}"><span class="tick" aria-hidden="true"></span><span>${c.label}<span class="sr-only">${c.ok ? ' — done' : ' — not yet'}</span></span></li>`)
        .join('');
    }
    el.addEventListener('input', renderStrength);
    renderStrength();

    el.addEventListener('reset', () => setTimeout(renderStrength));
    return form;
  }

  // Which auth card shows; the shell stays the same
  function show(which) {
    const login = which === 'login';
    document.getElementById('login-card').hidden = !login;
    document.getElementById('signup-card').hidden = login;
    document.title = (login ? 'Log in' : 'Sign up') + ' — CivicTrack';
  }

  function focusFirst(which) {
    const first = document.getElementById(which === 'login' ? 'login-email' : 'signup-name');
    if (first) first.focus({ preventScroll: true });
  }

  return { init, show, focusFirst };
})();
