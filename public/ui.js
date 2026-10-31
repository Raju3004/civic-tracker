// Shared UI helpers: API client, toasts, modal dialogs, form validation engine, password eye buttons.
// Exposes a single global: UI
(function () {
  const TOKEN_KEY = 'civictrack_token';

  // ---------- Text helpers ----------
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function timeAgo(dateLike) {
    const then = new Date(dateLike).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 45) return 'just now';
    const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2592000], ['year', 31536000]];
    let best = ['minute', 60];
    for (const u of units) if (seconds >= u[1]) best = u;
    const n = Math.max(1, Math.floor(seconds / best[1]));
    return `${n} ${best[0]}${n === 1 ? '' : 's'} ago`;
  }
  const formatDateTime = d => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // ---------- API client ----------
  class ApiError extends Error {
    constructor({ status, message, errors, retryAfterSeconds }) {
      super(message);
      this.status = status;
      this.errors = errors || null;
      this.retryAfterSeconds = retryAfterSeconds || null;
    }
  }

  const hooks = { onUnauthorized: null };

  async function api(path, { method = 'GET', json, form, auth = true } = {}) {
    const headers = {};
    const token = getToken();
    if (auth && token) headers.Authorization = 'Bearer ' + token;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : form });
    } catch (err) {
      throw new ApiError({ status: 0, message: 'Cannot reach the server. Check your connection and try again.' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      // non-JSON body (proxy error page etc.)
    }
    if (!res.ok) {
      const err = new ApiError({
        status: res.status,
        message: (data && data.error) || (res.status >= 500 ? 'The server had a problem. Please try again.' : 'Something went wrong.'),
        errors: data && data.errors,
        retryAfterSeconds: data && data.retryAfterSeconds,
      });
      if (res.status === 401 && auth && hooks.onUnauthorized) hooks.onUnauthorized(err);
      throw err;
    }
    return data;
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(token) {
    try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
  }

  // ---------- Toasts ----------
  const ICONS = {
    success: '<path d="M5 13l4 4L19 7" />',
    error: '<path d="M12 8v5m0 3.5v.01M10.3 3.9L2.6 17.2A2 2 0 004.3 20h15.4a2 2 0 001.7-2.8L13.7 3.9a2 2 0 00-3.4 0z" />',
    info: '<path d="M12 11v5m0-8.5v.01M12 21a9 9 0 100-18 9 9 0 000 18z" />',
  };

  function toast(message, type = 'info', duration = 4500) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `
      <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type] || ICONS.info}</svg>
      <span class="toast-msg">${escapeHtml(message)}</span>
      <button type="button" class="toast-close" aria-label="Dismiss notification">&times;</button>`;
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    region.appendChild(el);
    while (region.children.length > 4) region.firstChild.remove();
    if (duration) setTimeout(remove, duration);
  }

  // ---------- Modal dialogs (native <dialog>: focus trap + Esc come for free) ----------
  function openDialog(dialog) {
    return new Promise(resolve => {
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue);
      };
      dialog.addEventListener('close', onClose);
      dialog.returnValue = 'cancel';
      dialog.showModal();
    });
  }

  // confirmDialog({ title, message, confirmText, cancelText, danger }) -> Promise<boolean>
  async function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    const dialog = document.getElementById('confirm-dialog');
    dialog.querySelector('[data-title]').textContent = title;
    dialog.querySelector('[data-message]').textContent = message;
    const ok = dialog.querySelector('[data-confirm]');
    ok.textContent = confirmText;
    ok.className = danger ? 'btn btn-danger' : 'btn btn-accent';
    dialog.querySelector('[data-cancel]').textContent = cancelText;
    const result = await openDialog(dialog);
    return result === 'confirm';
  }

  // remarkDialog({ title, message, confirmText, danger }) -> Promise<string|null>
  // Collects the 10–500 character remark required when resolving or rejecting.
  async function remarkDialog({ title, message, confirmText, danger = false }) {
    const R = window.CivicRules;
    const dialog = document.getElementById('remark-dialog');
    const field = dialog.querySelector('[data-remark]');
    const error = dialog.querySelector('[data-remark-error]');
    const counter = dialog.querySelector('[data-remark-count]');
    const ok = dialog.querySelector('[data-confirm]');
    dialog.querySelector('[data-title]').textContent = title;
    dialog.querySelector('[data-message]').textContent = message;
    ok.textContent = confirmText;
    ok.className = danger ? 'btn btn-danger' : 'btn btn-accent';
    field.value = '';
    error.textContent = '';
    field.removeAttribute('aria-invalid');
    counter.textContent = `0 / ${R.REMARK.max}`;

    const update = showError => {
      counter.textContent = `${field.value.length} / ${R.REMARK.max}`;
      const msg = R.validateRemark(field.value, { required: true });
      error.textContent = showError ? msg : '';
      field.toggleAttribute('aria-invalid', Boolean(showError && msg));
      return msg;
    };
    const onInput = () => update(field.dataset.touched === '1');
    const onBlur = () => { field.dataset.touched = '1'; update(true); };
    const onSubmit = e => {
      if (e.submitter && e.submitter.value === 'confirm') {
        field.dataset.touched = '1';
        if (update(true)) {
          e.preventDefault();
          field.focus();
        }
      }
    };
    const form = dialog.querySelector('form');
    field.dataset.touched = '0';
    field.addEventListener('input', onInput);
    field.addEventListener('blur', onBlur);
    form.addEventListener('submit', onSubmit);
    const result = await openDialog(dialog);
    field.removeEventListener('input', onInput);
    field.removeEventListener('blur', onBlur);
    form.removeEventListener('submit', onSubmit);
    return result === 'confirm' ? R.stripHtml(field.value).trim() : null;
  }

  // ---------- Password show/hide ----------
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.1 10.1 0 0112 19c-6.4 0-10-7-10-7a17.5 17.5 0 014.1-4.9M9.9 5.2A9.7 9.7 0 0112 5c6.4 0 10 7 10 7a17.6 17.6 0 01-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 01-4.2-4.2"/></svg>';

  function initPasswordToggles(root = document) {
    root.querySelectorAll('.pw-toggle').forEach(btn => {
      const input = btn.closest('.password-wrap').querySelector('input');
      const sync = () => {
        const visible = input.type === 'text';
        btn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        btn.innerHTML = visible ? EYE_OFF : EYE;
      };
      btn.type = 'button';
      input.type = 'password'; // hidden by default
      sync();
      btn.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        sync();
        input.focus({ preventScroll: true });
      });
    });
  }

  // ---------- Form engine ----------
  // createForm({ form, validate(values) -> {field: msg}, submit(values), alias: {serverKey: fieldName} })
  //  - an error appears under a field once the user leaves it, or after a submit attempt
  //  - server-side { errors } are mapped to the matching field; unmatched ones go to the form banner
  //  - the submit button is disabled with a spinner while the request runs
  function createForm({ form, validate, submit, alias = {}, values: readValues }) {
    const wrappers = {};
    form.querySelectorAll('[data-field]').forEach(w => (wrappers[w.dataset.field] = w));
    const alertEl = form.querySelector('[data-form-alert]');
    const button = form.querySelector('button[type="submit"]');
    const touched = new Set();
    const serverErrors = {};
    let busy = false;

    const controlOf = name => wrappers[name] && wrappers[name].querySelector('[name]');

    function values() {
      if (readValues) return readValues();
      const out = {};
      form.querySelectorAll('[name]').forEach(el => {
        out[el.name] = el.type === 'password' ? el.value : typeof el.value === 'string' ? el.value : '';
      });
      return out;
    }

    function setFieldError(name, message) {
      const w = wrappers[name];
      if (!w) return;
      const errEl = w.querySelector('.field-error');
      const control = controlOf(name);
      if (errEl) errEl.textContent = message || '';
      w.classList.toggle('has-error', Boolean(message));
      if (control) {
        if (message) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
      }
    }

    function render() {
      const errors = validate(values());
      Object.keys(wrappers).forEach(name => {
        const show = serverErrors[name] || (touched.has(name) ? errors[name] : '');
        setFieldError(name, show || '');
      });
      return errors;
    }

    function setAlert(message, type = 'error') {
      if (!alertEl) return;
      alertEl.textContent = message || '';
      alertEl.dataset.type = type;
      alertEl.hidden = !message;
    }

    function setBusy(state) {
      busy = state;
      if (!button) return;
      button.disabled = state;
      button.classList.toggle('is-loading', state);
      button.setAttribute('aria-busy', state ? 'true' : 'false');
    }

    function focusFirstInvalid() {
      const first = Object.keys(wrappers).find(n => wrappers[n].classList.contains('has-error'));
      const control = first && controlOf(first);
      if (control) control.focus();
    }

    form.addEventListener('focusout', e => {
      const w = e.target.closest && e.target.closest('[data-field]');
      if (!w || !w.dataset.field) return;
      touched.add(w.dataset.field);
      render();
    });
    form.addEventListener('input', e => {
      const w = e.target.closest && e.target.closest('[data-field]');
      if (w) delete serverErrors[w.dataset.field];
      setAlert('');
      render();
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (busy) return;
      setAlert('');
      Object.keys(wrappers).forEach(n => touched.add(n));
      const errors = render();
      if (Object.keys(errors).length) {
        focusFirstInvalid();
        return;
      }
      setBusy(true);
      try {
        await submit(values());
      } catch (err) {
        handleServerError(err);
      } finally {
        setBusy(false);
      }
    });

    function handleServerError(err) {
      if (!(err instanceof ApiError)) {
        setAlert('Something went wrong. Please try again.');
        console.error(err);
        return;
      }
      const unmatched = [];
      if (err.errors) {
        Object.entries(err.errors).forEach(([key, msg]) => {
          const name = wrappers[key] ? key : alias[key];
          if (name && wrappers[name]) {
            serverErrors[name] = msg;
            touched.add(name);
          } else unmatched.push(msg);
        });
        render();
        if (unmatched.length) setAlert(unmatched.join(' '));
        focusFirstInvalid();
        return;
      }
      setAlert(err.message);
    }

    function reset() {
      form.reset();
      touched.clear();
      Object.keys(serverErrors).forEach(k => delete serverErrors[k]);
      setAlert('');
      render();
    }

    return { values, render, setAlert, setBusy, reset, touched, setFieldError, handleServerError, touchAll: () => Object.keys(wrappers).forEach(n => touched.add(n)) };
  }

  window.UI = {
    TOKEN_KEY, escapeHtml, timeAgo, formatDateTime, ApiError, api, hooks, getToken, setToken,
    toast, confirmDialog, remarkDialog, initPasswordToggles, createForm,
  };
})();
