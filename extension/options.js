'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { host: '127.0.0.1', basePort: 8765, span: 10, token: '' };
const $ = (id) => document.getElementById(id);

function isLoopback(host) {
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '127.0.0.1';
}

function show(message, kind) {
  const status = $('status');
  status.textContent = message;
  status.className = kind || '';
}

async function load() {
  const stored = await api.storage.local.get(DEFAULTS);
  $('host').value = stored.host;
  $('basePort').value = stored.basePort;
  $('span').value = stored.span;
  $('token').value = stored.token;
}

async function save() {
  const host = $('host').value.trim() || DEFAULTS.host;
  const basePort = Number($('basePort').value) || DEFAULTS.basePort;
  const span = Number($('span').value) || DEFAULTS.span;
  const token = $('token').value;

  if (/[\s/]/.test(host)) {
    show('Host must be a hostname or IP address, without a path.', 'error');
    return;
  }
  if (/^[^:]+:\d+$/.test(host)) {
    show('Put the port in "Base port", not in Host.', 'error');
    return;
  }

  // A non-loopback bridge needs a host permission, granted from this page so
  // the browser can show its permission prompt.
  if (!isLoopback(host)) {
    const origin = `http://${host}/*`;
    try {
      const granted = await api.permissions.request({ origins: [origin] });
      if (!granted) {
        show(`Access to ${origin} was not granted.`, 'error');
        return;
      }
    } catch (err) {
      show(`Could not request ${origin}: ${err.message || err}`, 'error');
      return;
    }
  }

  await api.storage.local.set({ host, basePort, span, token });
  show('Saved. The background worker reconnects on its own.', 'ok');
}

$('save').addEventListener('click', save);
load();
