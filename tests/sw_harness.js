#!/usr/bin/env node
/* Runs the real background.js in a Node VM with a fake content-script port
 * and real HTTP to the termchat CLI. This exercises the service worker's
 * prepare -> submit -> stream state machine without a browser. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const realFetch = globalThis.fetch;
const mode = process.argv[2] || '';
const repeated = mode === 'repeat';
const withMarkdown = mode === 'markdown';
const staleFirst = mode === 'stale';
let sawDone = false;
let statusCalls = 0;
let jobPolls = 0;
let activeId = 99;
let activated = 0;
let windowFocused = false;
let focusCalls = 0;

function fakeFetch(input, init) {
  if (String(input).includes('/v1/job')) jobPolls += 1;
  return realFetch(input, init).then((response) => {
    if (String(input).includes('/done') && !sawDone) {
      sawDone = true;
      setTimeout(() => {
        if (!platformCalls) {
          console.error('worker did not call its keepalive API');
          process.exit(1);
        }
        if (!activated) {
          console.error('worker did not foreground the chat tab');
          process.exit(1);
        }
        if (activeId === 7) {
          console.error('worker did not restore the previous tab');
          process.exit(1);
        }
        if (!focusCalls) {
          console.error('worker did not bring the chat window forward');
          process.exit(1);
        }
        if (windowFocused) {
          console.error('worker did not release window focus');
          process.exit(1);
        }
        process.exit(0);
      }, 800);
    }
    return response;
  });
}

let onConnect = null;
let platformCalls = 0;
const chrome = {
  runtime: {
    id: 'termchat-test',
    onConnect: { addListener: (fn) => { onConnect = fn; } },
    getPlatformInfo: () => {
      platformCalls += 1;
      return Promise.resolve({ os: 'linux', arch: 'x86-64' });
    },
  },
  storage: {
    local: {
      get: async (defaults) => ({
        ...defaults,
        basePort: Number(process.env.TERMCHAT_BASE_PORT || defaults.basePort),
      }),
      set: async () => {},
    },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, active: activeId === id }),
    query: async ({ active, windowId } = {}) =>
      active ? [{ id: activeId, windowId: windowId ?? 1, active: true }] : [],
    update: async (id, props = {}) => {
      if (props.active) {
        if (id === 7) activated += 1;
        activeId = id;
      }
      return { id, windowId: 1, active: activeId === id };
    },
  },
  windows: {
    get: async (id) => ({ id, focused: windowFocused, state: 'normal' }),
    update: async (id, props = {}) => {
      if (props.focused === true) {
        windowFocused = true;
        focusCalls += 1;
      }
      if (props.focused === false) windowFocused = false;
      return { id, focused: windowFocused, state: props.state || 'normal' };
    },
  },
};

const sandbox = {
  chrome,
  browser: undefined,
  fetch: fakeFetch,
  AbortController,
  URL,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'),
  sandbox,
  { filename: 'background.js' }
);

if (!onConnect) {
  console.error('background.js did not register onConnect');
  process.exit(1);
}

const listeners = [];
const port = {
  name: 'termchat',
  sender: { tab: { id: 7, url: 'https://gemini.google.com/app' } },
  onMessage: { addListener: (fn) => listeners.push(fn) },
  onDisconnect: { addListener: () => {} },
  disconnect: () => {},
  postMessage(msg) {
    if (!msg || msg.id == null) return;
    let reply;
    switch (msg.cmd) {
      case 'prepare':
        reply = {
          ready: true,
          pre: { count: repeated ? 1 : 0, last: repeated ? 'Hello world' : '' },
        };
        break;
      case 'submit':
        reply = { submitted: true, how: 'button' };
        break;
      case 'status': {
        statusCalls += 1;
        const frames = repeated
          ? ['', 'Hello world', 'Hello world', 'Hello world']
          : ['', 'Hel', 'Hello', 'Hello world', 'Hello world'];
        const text = frames[Math.min(statusCalls, frames.length - 1)];
        reply = {
          text,
          markdown: withMarkdown && text ? `**${text}**` : '',
          count: repeated ? 2 : statusCalls >= 2 ? 1 : 0,
          stop: statusCalls < frames.length,
          promptInComposer: false,
        };
        break;
      }
      case 'inspect':
        reply = { inspect: { fake: true } };
        break;
      case 'reset':
        reply = { ok: true };
        break;
      default:
        reply = { error: `unknown command ${msg.cmd}` };
    }
    setTimeout(() => {
      for (const fn of listeners) fn({ type: 'reply', id: msg.id, ...reply });
    }, 0);
  },
};

onConnect(port);
if (staleFirst) {
  // Pretend this tab still runs the content script from before a reload. The
  // worker must not poll or drive that port; it only starts on the current
  // build's hello.
  for (const fn of listeners) fn({ type: 'hello', site: 'gemini', version: '0.0.9' });
  setTimeout(() => {
    if (jobPolls || statusCalls || sawDone) {
      console.error('worker used a stale content script');
      process.exit(1);
    }
    for (const fn of listeners) fn({ type: 'hello', site: 'gemini', version: '0.1.5' });
  }, 2500);
} else {
  for (const fn of listeners) fn({ type: 'hello', site: 'gemini', version: '0.1.5' });
}

setTimeout(() => {
  console.error(`harness timed out (sawDone=${sawDone}, statusCalls=${statusCalls})`);
  process.exit(1);
}, 20000);
