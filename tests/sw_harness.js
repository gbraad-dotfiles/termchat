#!/usr/bin/env node
/* Runs the real background.js in a Node VM with a fake content-script port
 * and real HTTP to the termchat CLI. This exercises the service worker's
 * prepare -> submit -> stream state machine without a browser. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const realFetch = globalThis.fetch;
const repeated = process.argv[2] === 'repeat';
let sawDone = false;
let statusCalls = 0;

function fakeFetch(input, init) {
  return realFetch(input, init).then((response) => {
    if (String(input).includes('/done') && !sawDone) {
      sawDone = true;
      setTimeout(() => process.exit(0), 400);
    }
    return response;
  });
}

let onConnect = null;
const chrome = {
  runtime: {
    id: 'termchat-test',
    onConnect: { addListener: (fn) => { onConnect = fn; } },
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
for (const fn of listeners) fn({ type: 'hello', site: 'gemini', version: '0.1.0' });

setTimeout(() => {
  console.error(`harness timed out (sawDone=${sawDone}, statusCalls=${statusCalls})`);
  process.exit(1);
}, 20000);
