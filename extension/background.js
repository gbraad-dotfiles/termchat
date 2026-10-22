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

const VERSION = '0.1.0';

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

async function postDone(port, job, text, error, meta) {
  const payload = { text: text || '', error: error || null, meta: meta || null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await request(`/v1/job/${job.id}/done`, 'POST', payload, port);
    if (reply.ok) return;
    await sleep(200);
  }
}

/* ------------------------------------------------------------------ */
/* tab registry                                                        */
/* ------------------------------------------------------------------ */

const entries = new Map(); // site -> Map(tabId -> entry)
const active = new Set(); // sites currently running a job
const waiters = new Map(); // site -> Set(resolve)
let commandSeq = 0;
let pollRunning = false;

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

  const entry = { port, tabId: tab.id, site, pending: new Map(), connectedAt: 0 };

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'hello') {
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
    reply = await request(`/v1/job?site=${encodeURIComponent(site)}&wait=2`);
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

    while (Date.now() < deadline) {
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
        } catch {
          await waitForEntry(site, 15000);
          continue;
        }
        if (res.error) throw new Error(res.error);
        if (res.newchat) newChatWanted = false;
        if (res.ready) {
          pre = res.pre || { count: 0, last: '' };
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
        } catch {
          await waitForEntry(site, 15000);
          continue;
        }
        if (res.error) throw new Error(res.error);
        if (res.submitted) {
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
      } catch {
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
            await postDone(port, job, lastText, null, {
              site,
              duration_ms: Date.now() - startedAt,
              version: VERSION,
            });
            return;
          }
          stableAt = Date.now();
        }
      }

      await sleep(400);
    }

    if (lastText) {
      await resetTab(site);
      await postDone(port, job, lastText, null, {
        site,
        duration_ms: Date.now() - startedAt,
        version: VERSION,
      });
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
    await postDone(port, job, lastText, String((err && err.message) || err), meta);
  }
}
