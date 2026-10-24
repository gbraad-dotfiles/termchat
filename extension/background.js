/* termchat bridge — background service worker.
 *
 * The service worker owns all timing and networking:
 *   - polls the termchat CLI's loopback bridge for jobs
 *   - drives one job at a time per site through the content script
 *   - streams partial answers back to the CLI
 *
 * Doing timing here (instead of in the page) matters: browsers throttle
 * timers in hidden tabs to as little as once per minute, while messages
 * delivered to a content script are not throttled.
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const VERSION = '0.1.5';

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  basePort: 8765,
  span: 10,
  token: '',
};
let settings = { ...DEFAULT_SETTINGS };
let tokenWarned = false;

const REQUEST_TIMEOUT_MS = 8000;
const PING_TIMEOUT_MS = 700;
const RESCAN_MS = 5000;
const COMMAND_TIMEOUT_MS = 12000;
const ANSWER_START_TIMEOUT_MS = 60000;
const PROGRESS_MIN_MS = 250;

const SITE_BY_HOST = new Map([
  ['gemini.google.com', 'gemini'],
  ['copilot.microsoft.com', 'copilot'],
  ['chat.deepseek.com', 'deepseek'],
]);

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function normalizeSettings(raw) {
  const value = raw || {};
  const host = String(value.host || '').trim();
  const basePort = Number(value.basePort);
  const span = Number(value.span);
  return {
    host: host && !/[\s/]/.test(host) ? host : DEFAULT_SETTINGS.host,
    basePort:
      Number.isInteger(basePort) && basePort > 0 && basePort < 65536
        ? basePort
        : DEFAULT_SETTINGS.basePort,
    span:
      Number.isInteger(span) && span > 0 && span <= 50 ? span : DEFAULT_SETTINGS.span,
    token: String(value.token || ''),
  };
}

async function loadSettings() {
  try {
    const stored = await api.storage.local.get(DEFAULT_SETTINGS);
    settings = normalizeSettings(stored);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

const settingsReady = loadSettings();

/* Chrome does not inject content scripts into tabs that were already open when
 * the extension was installed or reloaded. Re-inject on worker startup so those
 * tabs start working without a manual reload; content.js ignores a second copy. */
const SITE_MATCHES = [
  'https://gemini.google.com/*',
  'https://copilot.microsoft.com/*',
  'https://chat.deepseek.com/*',
];

async function injectIntoOpenTabs() {
  if (!api.scripting || !api.tabs || !api.tabs.query) return;
  let tabs;
  try {
    tabs = await api.tabs.query({ url: SITE_MATCHES });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      if (api.tabs.update) {
        // Keep the background chat tab from being discarded; a discarded tab
        // has no content script and cannot be reached by the alarm.
        try {
          const result = api.tabs.update(tab.id, { autoDiscardable: false });
          if (result && result.catch) result.catch(() => {});
        } catch {
          /* older browsers do not support this property */
        }
      }
      if (tab.discarded) {
        // Reloading a discarded tab has no live state to lose and restores the
        // declared content script.
        try {
          await api.tabs.reload(tab.id);
        } catch {
          /* tab went away */
        }
        return;
      }
      try {
        await api.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch {
        /* navigation in progress */
      }
    })
  );
}

settingsReady.then(injectIntoOpenTabs);
if (api.runtime && api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    settingsReady.then(injectIntoOpenTabs);
  });
}

/* Browsers stop an idle service worker after about 30 seconds. The worker's
 * polling loop then dies silently, so a command reaches the bridge but no tab
 * asks for it until the user next touches the browser. A periodic alarm wakes
 * the worker and nudges the content scripts to reconnect, even when tab timers
 * are throttled. */
const POLL_ALARM = 'termchat-keepalive';

function ensureAlarm() {
  if (!api.alarms || !api.alarms.create) return;
  const create = (minutes) => {
    try {
      const result = api.alarms.create(POLL_ALARM, { periodInMinutes: minutes });
      // Firefox returns a promise and older Chrome builds reject a period
      // below one minute; fall back instead of leaving no alarm at all.
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          if (minutes !== 1) create(1);
        });
      }
      return true;
    } catch {
      return false;
    }
  };
  const createAlarm = () => {
    if (!create(0.5)) create(1);
  };
  // Creating an alarm with an existing name restarts its countdown. A worker
  // that restarts because of a port message must not keep pushing the alarm
  // into the future, so only create it when it is missing.
  if (api.alarms.get) {
    try {
      const existing = api.alarms.get(POLL_ALARM);
      if (existing && typeof existing.then === 'function') {
        existing
          .then((alarm) => {
            if (!alarm) createAlarm();
          })
          .catch(createAlarm);
        return;
      }
    } catch {
      /* fall through and create it */
    }
  }
  createAlarm();
}

async function wakeChatTabs() {
  // The worker may have been restarted with no live ports. Putting the content
  // script back into the tabs is what lets the wake message reach them.
  if (!entries.size) await injectIntoOpenTabs();
  startPolling();
  if (!api.tabs || !api.tabs.query || !api.tabs.sendMessage) return;
  let tabs;
  try {
    tabs = await api.tabs.query({ url: SITE_MATCHES });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) => {
      if (tab.id == null) return null;
      return Promise.resolve(
        api.tabs.sendMessage(tab.id, { type: 'termchat-wake' })
      ).catch(() => {});
    })
  );
}

if (api.alarms && api.alarms.onAlarm) {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === POLL_ALARM) wakeChatTabs();
  });
}
if (api.runtime && api.runtime.onStartup) {
  api.runtime.onStartup.addListener(ensureAlarm);
}
ensureAlarm();

function bridgeUrl(port, path) {
  const host =
    settings.host.includes(':') && !settings.host.startsWith('[')
      ? `[${settings.host}]`
      : settings.host;
  return `http://${host}:${port}${path}`;
}

function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  if (settings.token) headers['X-Termchat-Token'] = settings.token;
  return headers;
}

function portList() {
  return Array.from({ length: settings.span }, (_, i) => settings.basePort + i);
}

/* ------------------------------------------------------------------ */
/* loopback client                                                     */
/* ------------------------------------------------------------------ */

let knownPorts = [];
let scannedAt = 0;
let scanPromise = null;
let rotation = 0;

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!['host', 'basePort', 'span', 'token'].some((key) => key in changes)) return;
    settingsReady.then(async () => {
      await loadSettings();
      knownPorts = [];
      scannedAt = 0;
      tokenWarned = false;
      startPolling();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }).finally(() =>
    clearTimeout(timer)
  );
}

async function ping(port) {
  try {
    const res = await fetchWithTimeout(bridgeUrl(port, '/v1/ping'), {}, PING_TIMEOUT_MS);
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.app === 'termchat');
  } catch {
    return false;
  }
}

async function discover(force = false) {
  await settingsReady;
  const age = Date.now() - scannedAt;
  const ttl = knownPorts.length ? RESCAN_MS : 1500;
  if (!force && age < ttl) return knownPorts;
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    try {
      const found = await Promise.all(
        portList().map(async (port) => ((await ping(port)) ? port : null))
      );
      knownPorts = found.filter((port) => port !== null);
      scannedAt = Date.now();
      return knownPorts;
    } finally {
      scanPromise = null;
    }
  })();
  return scanPromise;
}

async function request(path, method = 'GET', body = null, port = null) {
  await settingsReady;
  let ports;
  if (port) {
    // Progress and completion must reach the CLI process that issued the job.
    ports = [port];
  } else {
    ports = await discover(false);
    if (!ports.length) return { ok: true, status: 0, json: null, port: null };
  }

  let lastError = '';
  for (let i = 0; i < ports.length; i += 1) {
    const target = ports[(rotation + i) % ports.length];
    try {
      const res = await fetchWithTimeout(bridgeUrl(target, path), {
        method,
        headers: authHeaders(
          body !== null ? { 'Content-Type': 'application/json' } : {}
        ),
        body: body !== null ? JSON.stringify(body) : undefined,
      });
      rotation = (rotation + i + 1) % ports.length;
      if (res.status === 204) return { ok: true, status: 204, json: null, port: target };
      const json = await res.json().catch(() => null);
      if (res.ok) return { ok: true, status: res.status, json, port: target };
      lastError = (json && json.error) || `HTTP ${res.status}`;
    } catch (err) {
      lastError = String((err && err.message) || err);
      knownPorts = knownPorts.filter((p) => p !== target);
    }
  }
  if (!knownPorts.length) scannedAt = 0;
  return { ok: false, error: lastError || 'no termchat bridge reachable', port: null };
}

async function progress(port, job, text) {
  try {
    await request(`/v1/job/${job.id}/progress`, 'POST', { text }, port);
  } catch {
    /* the CLI may have gone away; the answer is still returned via done */
  }
}

async function postDone(port, job, text, error, meta, markdown = '') {
  const payload = { text: text || '', error: error || null, meta: meta || null };
  if (markdown) payload.markdown = markdown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await request(`/v1/job/${job.id}/done`, 'POST', payload, port);
    if (reply.ok) return;
    await sleep(200);
  }
}

/* Diagnostics from the worker and the page end up in the bridge's log and in
 * `termchat <site> --check -v`. They are fire-and-forget: a diagnostic must
 * never delay or break the job. */
function pageLog(port, job, message) {
  request(`/v1/job/${job.id}/log`, 'POST', { level: 'info', message: String(message) }, port)
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* tab registry                                                        */
/* ------------------------------------------------------------------ */

const entries = new Map(); // site -> Map(tabId -> entry)
const active = new Set(); // sites currently running a job
const waiters = new Map(); // site -> Set(resolve)
let commandSeq = 0;
let pollRunning = false;
let aliveAt = 0;

/* An in-flight fetch does not reset the service worker's 30 second idle timer.
 * While there are tabs to poll, make a cheap extension API call often enough
 * that the worker stays alive even when the page is hidden and its timers are
 * throttled. The alarm remains the fallback for a worker that was already
 * stopped. */
function keepWorkerAlive() {
  const now = Date.now();
  if (now - aliveAt < 20000) return;
  aliveAt = now;
  try {
    if (api.runtime && api.runtime.getPlatformInfo) {
      const result = api.runtime.getPlatformInfo();
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return;
    }
    if (api.storage && api.storage.local) {
      const result = api.storage.local.get('termchat-keepalive');
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  } catch {
    /* the worker is shutting down */
  }
}

function siteForUrl(url) {
  try {
    return SITE_BY_HOST.get(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

function pickEntry(site) {
  const tabs = entries.get(site);
  if (!tabs || !tabs.size) return null;
  let best = null;
  for (const entry of tabs.values()) {
    if (!best || (entry.connectedAt || 0) > (best.connectedAt || 0)) best = entry;
  }
  return best;
}

function register(entry) {
  let tabs = entries.get(entry.site);
  if (!tabs) {
    tabs = new Map();
    entries.set(entry.site, tabs);
  }
  const previous = tabs.get(entry.tabId);
  if (previous && previous !== entry) {
    try {
      previous.port.disconnect();
    } catch {
      /* ignore */
    }
  }
  entry.connectedAt = Date.now();
  tabs.set(entry.tabId, entry);
  if (previous !== entry && api.tabs && api.tabs.update) {
    // Do not let the browser discard the chat tab while it is in the
    // background; a discarded tab cannot be woken by an alarm.
    try {
      const result = api.tabs.update(entry.tabId, { autoDiscardable: false });
      if (result && result.catch) result.catch(() => {});
    } catch {
      /* older browsers do not support this property */
    }
  }
}

function unregister(entry) {
  const tabs = entries.get(entry.site);
  if (!tabs) return;
  if (tabs.get(entry.tabId) === entry) tabs.delete(entry.tabId);
  if (!tabs.size) entries.delete(entry.site);
}

function wake(site) {
  const pending = waiters.get(site);
  if (!pending) return;
  const entry = pickEntry(site);
  for (const notify of [...pending]) notify(entry);
  waiters.delete(site);
}

function waitForEntry(site, ms) {
  const existing = pickEntry(site);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (entry) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pending = waiters.get(site);
      if (pending) {
        pending.delete(finish);
        if (!pending.size) waiters.delete(site);
      }
      resolve(entry);
    };
    const timer = setTimeout(() => finish(null), ms);
    let pending = waiters.get(site);
    if (!pending) {
      pending = new Set();
      waiters.set(site, pending);
    }
    pending.add(finish);
  });
}

function sendCommand(entry, payload, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = ++commandSeq;
    if (!entry.pending) entry.pending = new Map();
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`the page did not answer "${payload.cmd}"`));
    }, timeoutMs);
    entry.pending.set(id, { resolve, reject, timer });
    try {
      entry.port.postMessage({ id, ...payload });
    } catch (err) {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(err);
    }
  });
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'termchat') return;
  const tab = port.sender && port.sender.tab;
  const site = tab && tab.url ? siteForUrl(tab.url) : null;
  if (!site || tab.id == null) {
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    return;
  }

  const entry = {
    port,
    tabId: tab.id,
    site,
    pending: new Map(),
    connectedAt: 0,
    version: '',
  };

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'hello') {
      // A tab can still run the content script from before the extension was
      // reloaded. Never route jobs through it; the content script injected by
      // the worker connects with the matching build and takes over. Leave the
      // stale port open: disconnecting it makes an older build reconnect in a
      // loop.
      const version = String(msg.version || '');
      if (version !== VERSION) return;
      entry.version = version;
      register(entry);
      wake(site);
      startPolling();
      return;
    }
    if (msg.type === 'reply' && msg.id != null) {
      const pending = entry.pending.get(msg.id);
      if (!pending) return;
      entry.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    unregister(entry);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('the chat tab was closed or reloaded'));
    }
    entry.pending.clear();
  });
});

/* ------------------------------------------------------------------ */
/* job polling                                                         */
/* ------------------------------------------------------------------ */

function startPolling() {
  if (pollRunning) return;
  pollRunning = true;
  (async () => {
    try {
      while (entries.size) {
        keepWorkerAlive();
        await Promise.all([...entries.keys()].map(pollSite));
        await sleep(100);
      }
    } finally {
      pollRunning = false;
      if (entries.size) startPolling();
    }
  })();
}

async function pollSite(site) {
  if (!entries.has(site) || active.has(site)) return;
  let reply;
  try {
    reply = await request(
      `/v1/job?site=${encodeURIComponent(site)}&wait=2&version=${encodeURIComponent(VERSION)}`
    );
  } catch {
    await sleep(500);
    return;
  }
  if (reply.status === 401) {
    if (!tokenWarned) {
      tokenWarned = true;
      console.warn(
        'termchat: the bridge rejected the token; set the same token in the extension options'
      );
    }
    await sleep(2000);
    return;
  }
  if (!reply.ok || reply.status === 0) {
    await sleep(800);
    return;
  }
  const job = reply.json;
  if (!job || !job.id) return;

  const entry = pickEntry(site);
  if (!entry) {
    await postDone(reply.port, job, '', 'no chat tab is open', { site, version: VERSION });
    return;
  }

  active.add(site);
  // Do not await the job: other sites keep being polled while it runs.
  runJob(site, job, reply.port, entry)
    .catch(async (err) => {
      const meta = {
        site,
        version: VERSION,
        inspect: await safeInspect(pickEntry(site)),
      };
      await postDone(reply.port, job, '', String((err && err.message) || err), meta);
    })
    .finally(() => active.delete(site));
}

async function safeInspect(entry) {
  if (!entry) return null;
  try {
    const res = await sendCommand(entry, { cmd: 'inspect' }, 4000);
    return res.inspect || null;
  } catch {
    return null;
  }
}

async function resetTab(site) {
  const entry = pickEntry(site);
  if (!entry) return;
  try {
    await sendCommand(entry, { cmd: 'reset' }, 2000);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* one job                                                             */
/* ------------------------------------------------------------------ */

// Gemini (and the other sites) do not reliably submit or repaint from a
// hidden tab: a synthetic click can be ignored and the answer text can lag
// until the page is visible again. While a job runs, select its chat tab and
// bring its window forward. The tab that was selected before, and the window
// that had focus, are restored at the end. (A tab in an unpainted background
// window is still hidden to the page even when it is the active tab there,
// which is why focusing only the tab is not enough.)
//
// Jobs for different sites can run at once in the same window, so track how
// many jobs have foregrounded a tab there; only the last one restores it.
const foreground = new Map();

async function showChatTab(entry) {
  if (!api.tabs || !api.tabs.get || entry.tabId == null) {
    return { skipped: 'no tabs api' };
  }
  try {
    const tab = await api.tabs.get(entry.tabId);
    if (!tab) return { skipped: 'tab not found' };
    let win = null;
    if (api.windows && api.windows.get) {
      try {
        win = await api.windows.get(tab.windowId);
      } catch {
        /* window may be gone */
      }
    }
    const details = {
      tab: tab.id,
      window: tab.windowId,
      active: Boolean(tab.active),
      focused: Boolean(win && win.focused),
      state: win ? win.state : '',
      previous: null,
      raised: false,
    };
    if (details.active && details.focused && (!win || win.state !== 'minimized')) {
      return details; // already visible; nothing to select or restore
    }

    let state = foreground.get(tab.windowId);
    if (!state) {
      try {
        const shown = await api.tabs.query({ active: true, windowId: tab.windowId });
        if (shown && shown.length && shown[0].id !== tab.id) {
          details.previous = shown[0].id;
        }
      } catch {
        /* query is optional; without it the previous tab is not restored */
      }
      state = { previous: details.previous, depth: 0, tabs: new Set() };
      foreground.set(tab.windowId, state);
    }
    if (!tab.active) {
      try {
        await api.tabs.update(tab.id, { active: true });
      } catch (err) {
        details.error = String((err && err.message) || err);
      }
    }
    if (win && (!win.focused || win.state === 'minimized') && api.windows && api.windows.update) {
      const props = { focused: true };
      if (win.state === 'minimized') props.state = 'normal';
      try {
        await api.windows.update(tab.windowId, props);
        details.raised = true;
      } catch (err) {
        details.error = String((err && err.message) || err);
      }
    }
    state.depth += 1;
    state.tabs.add(tab.id);
    return details;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

async function restoreChatTab(saved) {
  if (!saved || saved.skipped || saved.window == null) return '';
  const state = foreground.get(saved.window);
  if (!state) return '';
  state.depth -= 1;
  if (state.depth > 0) return 'deferred';
  foreground.delete(saved.window);
  let what = '';
  try {
    if (state.previous != null) {
      const current = await api.tabs.query({ active: true, windowId: saved.window });
      // Only restore when the active tab is one we selected; if the user has
      // chosen another tab in the meantime, leave their choice alone.
      if (current && current.length && state.tabs.has(current[0].id)) {
        await api.tabs.update(state.previous, { active: true });
        what = `tab=${state.previous}`;
      }
    }
  } catch {
    /* the window or tab may be gone */
  }
  if (saved.raised && api.windows && api.windows.update) {
    try {
      // Brings the next window in the z-order forward, normally the terminal.
      await api.windows.update(saved.window, { focused: false });
      what += (what ? ' ' : '') + 'unfocused';
    } catch {
      /* the window may be gone */
    }
  }
  return what;
}

function tidy(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flat(text) {
  return tidy(text).replace(/\s+/g, ' ').trim();
}

async function runJob(site, job, port, firstEntry) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(30000, Number(job.timeout_ms) || 300000);
  const deadline = startedAt + timeoutMs;
  const jobId = job.id;
  const prompt = String(job.prompt || '');
  const wantNew = Boolean(job.new_chat);
  let lastText = '';
  let lastMarkdown = '';

  const shown = await showChatTab(firstEntry);
  pageLog(
    port,
    job,
    shown.error
      ? `start tab=${firstEntry.tabId} error=${shown.error}`
      : shown.skipped
        ? `start tab=${firstEntry.tabId} skipped=${shown.skipped}`
        : `start tab=${shown.tab} active=${shown.active} focused=${shown.focused} ` +
          `state=${shown.state || '?'} previous=${shown.previous ?? '-'} raised=${shown.raised}`
  );

  try {
    if (job.inspect) {
      const res = await sendCommand(firstEntry, { cmd: 'inspect' }, 8000);
      await postDone(port, job, '', null, res.inspect || null);
      return;
    }
    if (!prompt.trim()) throw new Error('the CLI sent an empty prompt');

    let phase = 'prepare';
    let newChatWanted = wantNew;
    let pre = { count: 0, last: '' };
    let stableAt = Date.now();
    let submitAt = 0;
    let submitAttempts = 0;
    let sawNew = false;
    let lastSent = '';
    let lastSentAt = 0;
    let sawNewLogged = false;
    const env = (res) =>
      `vis=${res.vis || '?'} focus=${res.focus} size=${res.w ?? '?'}x${res.h ?? '?'}`;

    while (Date.now() < deadline) {
      keepWorkerAlive();
      const entry = pickEntry(site);
      if (!entry) {
        if (phase === 'stream') {
          await sleep(500);
        } else {
          await waitForEntry(site, 10000);
        }
        continue;
      }

      if (phase === 'prepare') {
        let res;
        try {
          res = await sendCommand(
            entry,
            { cmd: 'prepare', job_id: jobId, prompt, new_chat: newChatWanted },
            12000
          );
        } catch (err) {
          pageLog(port, job, `prepare did not answer: ${String((err && err.message) || err)}`);
          await waitForEntry(site, 15000);
          continue;
        }
        if (res.error) throw new Error(res.error);
        if (res.newchat) newChatWanted = false;
        if (res.ready) {
          pre = res.pre || { count: 0, last: '' };
          pageLog(port, job, `prepare ready ${env(res)}`);
          phase = 'submit';
          continue;
        }
        await sleep(res.newchat ? 1200 : 400);
        continue;
      }

      if (phase === 'submit') {
        let res;
        try {
          res = await sendCommand(entry, { cmd: 'submit', job_id: jobId }, 15000);
        } catch (err) {
          pageLog(port, job, `submit did not answer: ${String((err && err.message) || err)}`);
          await waitForEntry(site, 15000);
          continue;
        }
        if (res.error) throw new Error(res.error);
        if (res.submitted) {
          pageLog(port, job, `submit how=${res.how || '?'} ${env(res)}`);
          phase = 'stream';
          submitAt = Date.now();
          stableAt = Date.now();
          continue;
        }
        phase = 'prepare'; // the editor was empty (new-chat reset); type again
        await sleep(400);
        continue;
      }

      // phase === 'stream'
      let res;
      try {
        res = await sendCommand(entry, { cmd: 'status', job_id: jobId }, 8000);
      } catch (err) {
        pageLog(port, job, `status did not answer: ${String((err && err.message) || err)}`);
        await waitForEntry(site, 15000);
        continue;
      }

      let text = tidy(res.text || '');
      if (text && flat(text) === flat(prompt)) text = ''; // user's own message
      // A new answer can repeat the previous one verbatim (same question,
      // --continue), so the response count is the reliable "something new"
      // signal; text alone would wait for the answer-start timeout.
      const isNewAnswer = text !== pre.last || Number(res.count) > Number(pre.count || 0);
      if (text && isNewAnswer) {
        sawNew = true;
        if (!sawNewLogged) {
          sawNewLogged = true;
          pageLog(port, job, `answer started ${env(res)} stop=${Boolean(res.stop)}`);
        }
        lastMarkdown = String(res.markdown || '');
        if (text !== lastText) {
          lastText = text;
          stableAt = Date.now();
        }
        if (text !== lastSent && Date.now() - lastSentAt >= PROGRESS_MIN_MS) {
          lastSent = text;
          lastSentAt = Date.now();
          progress(port, job, text);
        }
      }

      if (!sawNew) {
        if (res.promptInComposer && submitAttempts < 2 && Date.now() - submitAt > 2500) {
          submitAttempts += 1;
          phase = 'submit';
          continue;
        }
        if (!res.stop && Date.now() - startedAt > ANSWER_START_TIMEOUT_MS) {
          throw new Error(
            'the page did not start answering. Is the chat signed in? Run --inspect.'
          );
        }
      } else {
        const quietFor = Date.now() - stableAt;
        // With a stop control visible the model is still generating; a pause
        // there can be long reasoning, so only use the fallback after 20 s.
        // Without one, 1.5 s of stable text means the answer is finished.
        const settled = res.stop ? quietFor > 20000 : quietFor > 1500;
        if (settled) {
          await sleep(350);
          let confirm;
          try {
            confirm = await sendCommand(entry, { cmd: 'status', job_id: jobId }, 5000);
          } catch {
            continue;
          }
          if (tidy(confirm.text || '') === lastText) {
            await resetTab(site);
            await postDone(
              port,
              job,
              lastText,
              null,
              {
                site,
                duration_ms: Date.now() - startedAt,
                version: VERSION,
              },
              String(confirm.markdown || lastMarkdown)
            );
            return;
          }
          stableAt = Date.now();
        }
      }

      await sleep(400);
    }

    if (lastText) {
      await resetTab(site);
      await postDone(
        port,
        job,
        lastText,
        null,
        {
          site,
          duration_ms: Date.now() - startedAt,
          version: VERSION,
        },
        lastMarkdown
      );
      return;
    }
    throw new Error('timed out waiting for an answer');
  } catch (err) {
    const meta = {
      site,
      duration_ms: Date.now() - startedAt,
      version: VERSION,
      inspect: await safeInspect(pickEntry(site)),
    };
    await resetTab(site);
    await postDone(
      port,
      job,
      lastText,
      String((err && err.message) || err),
      meta,
      lastMarkdown
    );
  } finally {
    const restored = await restoreChatTab(shown);
    pageLog(port, job, `restored ${restored || 'nothing'}`);
  }
}
