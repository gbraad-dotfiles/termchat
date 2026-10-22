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

async function pingPort(host, port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`http://${host}:${port}/v1/ping`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function test() {
  const host = $('host').value.trim() || DEFAULTS.host;
  const basePort = Number($('basePort').value) || DEFAULTS.basePort;
  const span = Math.max(1, Number($('span').value) || DEFAULTS.span);
  const ports = Array.from({ length: span }, (_, i) => basePort + i);
  show(`Testing http://${host}:${basePort}-${basePort + span - 1} ...`);

  const answers = await Promise.all(ports.map((port) => pingPort(host, port)));
  for (let i = 0; i < ports.length; i += 1) {
    const info = answers[i];
    if (info && info.app === 'termchat') {
      const mode = info.mode || 'bridge';
      const polls = (info.polls || []).join(', ') || 'none';
      const age = info.last_ping_age;
      const seen =
        typeof age === 'number' ? ` Last worker contact: ${age}s ago.` : '';
      show(
        `Found termchat on ${host}:${ports[i]} (${mode}). ` +
          `Extension polling: ${polls}.${seen}`,
        'ok'
      );
      return;
    }
  }
  show(
    `No termchat bridge answered on ${host}:${basePort}-${basePort + span - 1}. ` +
      "Check that 'termchat serve' is running, and that Host and Base port match it.",
    'error'
  );
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
