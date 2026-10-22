/* termchat bridge — content script for Gemini, Copilot and DeepSeek.
 *
 * The background worker drives jobs and owns all timing; this script only
 * answers small synchronous commands:
 *   prepare  — optionally start a new chat, put the prompt in the composer
 *   submit   — click the send button (or press Enter)
 *   status   — return the current answer text and whether it is still running
 *   inspect  — describe the page for debugging drifted selectors
 *   reset    — forget per-job state
 *
 * All selectors live in ADAPTERS. When a site changes its DOM, run
 *   termchat <site> --inspect
 * to see what the extension can find.
 */

(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.connect) return;

  const SITE = {
    'gemini.google.com': 'gemini',
    'copilot.microsoft.com': 'copilot',
    'chat.deepseek.com': 'deepseek',
  }[location.hostname];
  if (!SITE) return;

  const VERSION = '0.1.0';

  const ADAPTERS = {
    gemini: {
      compose: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'button.send-button',
        'button[type="submit"]',
      ],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
      response: [
        '.model-response-text',
        'message-content .markdown',
        'message-content',
        'model-response',
      ],
      newChat: [
        'button[aria-label*="New chat" i]',
        'a[aria-label*="New chat" i]',
        'a[href="/app"]',
      ],
    },
    copilot: {
      compose: [
        '#userInput',
        'textarea[data-testid*="input" i]',
        'textarea[placeholder*="Message" i]',
        'textarea',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
      ],
      send: [
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
        'button[title*="Submit" i]',
        'button[title*="Send" i]',
        'button[data-testid*="send" i]',
        'button[type="submit"]',
      ],
      stop: ['button[aria-label*="Stop" i]'],
      response: [
        '[data-content="ai-message"]',
        '[data-testid*="ai-message" i]',
        'cib-message-group[source="bot"]',
        'cib-message[source="bot"]',
        '[data-author="bot"]',
        '.ac-textBlock',
      ],
      newChat: [
        'button[aria-label*="New chat" i]',
        'a[aria-label*="New chat" i]',
        'button[data-testid*="new-chat" i]',
      ],
    },
    deepseek: {
      compose: [
        'textarea#chat-input',
        'textarea[placeholder]',
        'textarea',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
      ],
      send: [
        'button[aria-label*="Send" i]',
        'div[role="button"][aria-label*="Send" i]',
        'button[type="submit"]',
      ],
      stop: [
        'button[aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Stop" i]',
      ],
      response: ['div.ds-markdown', '.ds-markdown--block', '[class*="ds-markdown"]'],
      newChat: [
        'button[aria-label*="New chat" i]',
        'a[aria-label*="New chat" i]',
        'div[role="button"][aria-label*="New chat" i]',
      ],
    },
  };

  const adapter = ADAPTERS[SITE];

  const state = {
    port: null,
    reconnecting: false,
    jobId: null,
    composer: null,
    prompt: '',
  };

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */

  let rootsCache = [];
  let rootsBuiltAt = 0;

  function roots() {
    const now = performance.now();
    if (rootsCache.length && now - rootsBuiltAt < 2000) return rootsCache;
    const list = [document];
    const walk = (root) => {
      let nodes;
      try {
        nodes = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of nodes) {
        if (el.shadowRoot && !list.includes(el.shadowRoot)) {
          list.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    rootsCache = list;
    rootsBuiltAt = now;
    return list;
  }

  function deepQueryAll(selector) {
    const out = [];
    for (const root of roots()) {
      let found;
      try {
        found = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of found) out.push(el);
    }
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function findFirst(selectors) {
    for (const selector of selectors) {
      for (const el of deepQueryAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function deepText(el) {
    if (!el) return '';
    if (!el.shadowRoot) return el.innerText ?? el.textContent ?? '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) walk(child);
        return;
      }
      if (node.tagName === 'BR') {
        parts.push('\n');
        return;
      }
      if (!node.firstElementChild) {
        parts.push(node.innerText ?? node.textContent ?? '');
        return;
      }
      const block = /^(DIV|P|LI|PRE|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE|TR)$/.test(node.tagName);
      for (const child of node.childNodes) walk(child);
      if (block) parts.push('\n');
    };
    for (const child of el.shadowRoot.childNodes) walk(child);
    return parts.join('');
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

  /* ------------------------------------------------------------------ */
  /* finding parts of the page                                           */
  /* ------------------------------------------------------------------ */

  function findComposer() {
    const selectors = [...adapter.compose, '[contenteditable="true"]', 'textarea'];
    const seen = new Set();
    let best = null;
    let bestScore = -Infinity;
    for (const selector of selectors) {
      for (const el of deepQueryAll(selector)) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        if (el.disabled || el.readOnly) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        const rect = el.getBoundingClientRect();
        const score = rect.bottom + Math.min((rect.width * rect.height) / 4000, 120);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function collectResponses() {
    const seen = new Set();
    const found = [];
    for (const selector of adapter.response) {
      for (const el of deepQueryAll(selector)) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        if (!flat(deepText(el))) continue;
        found.push(el);
      }
    }
    // Keep the innermost candidates (a container and its .markdown child
    // describe the same answer).
    const kept = found.filter(
      (el) => !found.some((other) => other !== el && el.contains(other))
    );
    kept.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return kept;
  }

  function responseSignature() {
    const responses = collectResponses();
    return {
      count: responses.length,
      last: responses.length ? tidy(deepText(responses[responses.length - 1])) : '',
    };
  }

  function sendCandidates() {
    const out = [];
    const seen = new Set();
    for (const selector of adapter.send) {
      for (const el of deepQueryAll(selector)) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    if (!out.length) {
      for (const el of deepQueryAll('button, [role="button"]')) {
        if (!isVisible(el) || el.disabled) continue;
        const label = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('data-testid'),
        ]
          .filter(Boolean)
          .join(' ');
        if (/send|submit|发送|送信/i.test(label)) out.push(el);
      }
    }
    return out;
  }

  function usable(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isVisible(el);
  }

  function findStopButton() {
    const direct = findFirst(adapter.stop);
    if (direct) return direct;

    // DeepSeek's stop control has no useful label: it is the square that
    // replaces the arrow next to the composer while an answer streams.
    const composer =
      state.composer && state.composer.isConnected ? state.composer : findComposer();
    if (!composer) return null;
    const composerRect = composer.getBoundingClientRect();
    for (const el of deepQueryAll('button, [role="button"]')) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      if (centerY < composerRect.top - 100 || centerY > composerRect.bottom + 40) continue;
      if (rect.left < composerRect.right - 220) continue;
      const svg = el.querySelector('svg');
      if (!svg || svg.querySelector('path')) continue;
      if (svg.querySelector('rect')) return el;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* writing into the composer                                           */
  /* ------------------------------------------------------------------ */

  function composerText(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : deepText(el);
  }

  function composerHas(el, text) {
    const have = flat(composerText(el));
    const want = flat(text);
    if (!want) return have.length === 0;
    return have.includes(want.slice(0, Math.min(240, want.length)));
  }

  function composerExact(el, text) {
    return tidy(composerText(el)) === tidy(text);
  }

  function composerEmpty(el) {
    return flat(composerText(el)).length === 0;
  }

  function selectContents(el) {
    el.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function pasteInto(el, text) {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      el.dispatchEvent(event);
    } catch {
      /* ignore */
    }
  }

  function setComposer(el, text) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {
      /* ignore */
    }
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const multiline = text.includes('\n');
    const acceptable = () => (multiline ? composerExact(el, text) : composerHas(el, text));

    // 1. execCommand insertText (widely understood by rich-text editors)
    selectContents(el);
    try {
      document.execCommand('insertText', false, text);
    } catch {
      /* ignore */
    }
    if (acceptable()) return;

    // 2. a synthetic paste, which Quill/ProseMirror-style editors handle well
    selectContents(el);
    pasteInto(el, text);
    if (acceptable()) return;

    // 3. line by line, using real line breaks
    selectContents(el);
    try {
      text.split('\n').forEach((line, index) => {
        if (index) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    } catch {
      /* ignore */
    }
    if (acceptable()) return;

    // 4. last resort: replace the content and announce an input event
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function pressEnter(el) {
    const make = (type) => {
      const event = new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      try {
        Object.defineProperty(event, 'keyCode', { get: () => 13 });
        Object.defineProperty(event, 'which', { get: () => 13 });
      } catch {
        /* ignore */
      }
      return event;
    };
    el.dispatchEvent(make('keydown'));
    el.dispatchEvent(make('keypress'));
    el.dispatchEvent(make('keyup'));
  }

  /* ------------------------------------------------------------------ */
  /* commands                                                            */
  /* ------------------------------------------------------------------ */

  function resetState() {
    state.jobId = null;
    state.composer = null;
    state.prompt = '';
  }

  function prepare(msg) {
    if (msg.job_id !== state.jobId) {
      state.jobId = msg.job_id;
      state.composer = null;
    }
    state.prompt = String(msg.prompt || '');

    // New chat is best-effort: click the button once, then type into whatever
    // the app shows. We deliberately do not navigate, so a reload can never
    // lose a job that is already in flight.
    if (msg.new_chat && collectResponses().length > 0) {
      const button = findFirst(adapter.newChat);
      if (button) {
        button.click();
        return { ready: false, newchat: true };
      }
    }

    const composer = findComposer();
    if (!composer) return { ready: false };
    const pre = responseSignature();

    if (composerHas(composer, state.prompt)) {
      state.composer = composer;
      return { ready: true, pre, typed: true };
    }

    setComposer(composer, state.prompt);
    if (!composerHas(composer, state.prompt)) {
      return {
        ready: false,
        error: 'could not type the prompt into the message box (try --inspect)',
      };
    }
    state.composer = composer;
    return { ready: true, pre, typed: true };
  }

  function submit() {
    const composer =
      state.composer && state.composer.isConnected ? state.composer : findComposer();
    if (!composer) return { submitted: false, empty: true };
    if (composerEmpty(composer)) return { submitted: false, empty: true };

    const button = sendCandidates().find(usable);
    if (button) {
      button.click();
      return { submitted: true, how: 'button' };
    }
    pressEnter(composer);
    return { submitted: true, how: 'enter' };
  }

  function status() {
    const responses = collectResponses();
    const response = responses.length ? responses[responses.length - 1] : null;
    const composer =
      state.composer && state.composer.isConnected ? state.composer : findComposer();
    return {
      text: response ? tidy(deepText(response)) : '',
      count: responses.length,
      stop: Boolean(findStopButton()),
      promptInComposer: composer ? composerHas(composer, state.prompt) : false,
      url: location.href,
    };
  }

  function describe(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: (el.getAttribute('class') || '').slice(0, 160) || null,
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      testid: el.getAttribute('data-testid'),
      placeholder: el.getAttribute('placeholder'),
      rect: [
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
      ],
      text: tidy(deepText(el)).slice(0, 140),
    };
  }

  function listing(selectors, limit) {
    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const el of deepQueryAll(selector)) {
        if (seen.has(el) || out.length >= limit) continue;
        seen.add(el);
        out.push(describe(el));
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  function inspectPage() {
    const composer = findComposer();
    const composerRect = composer ? composer.getBoundingClientRect() : null;
    const nearbyButtons = [];
    if (composerRect) {
      for (const el of deepQueryAll('button, [role="button"]')) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const centerY = (rect.top + rect.bottom) / 2;
        if (centerY < composerRect.top - 120 || centerY > composerRect.bottom + 60) continue;
        if (rect.left < composerRect.left) continue;
        nearbyButtons.push(describe(el));
        if (nearbyButtons.length >= 8) break;
      }
    }
    return {
      site: SITE,
      version: VERSION,
      url: location.href,
      title: document.title,
      collectedAt: new Date().toISOString(),
      shadowRoots: roots().length - 1,
      composer: describe(composer),
      composerCandidates: listing(adapter.compose, 6),
      sendMatches: listing(adapter.send, 5),
      stopMatches: listing(adapter.stop, 3),
      responseCandidates: listing(adapter.response, 6),
      responseCount: collectResponses().length,
      nearbyButtons,
    };
  }

  function onMessage(msg) {
    if (!msg || msg.id == null) return;
    let reply;
    try {
      if (msg.cmd === 'prepare') reply = prepare(msg);
      else if (msg.cmd === 'submit') reply = submit();
      else if (msg.cmd === 'status') reply = status();
      else if (msg.cmd === 'inspect') reply = { inspect: inspectPage() };
      else if (msg.cmd === 'reset') {
        resetState();
        reply = { ok: true };
      } else reply = { error: `unknown command ${msg.cmd}` };
    } catch (err) {
      reply = { error: String((err && err.message) || err) };
    }
    try {
      if (state.port) state.port.postMessage({ type: 'reply', id: msg.id, ...reply });
    } catch {
      /* the worker went away; reconnect will take over */
    }
  }

  /* ------------------------------------------------------------------ */
  /* connection                                                          */
  /* ------------------------------------------------------------------ */

  function connect() {
    if (state.port) return;
    let port;
    try {
      port = api.runtime.connect({ name: 'termchat' });
    } catch {
      scheduleReconnect();
      return;
    }
    state.port = port;
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      state.composer = null;
      scheduleReconnect();
    });
    try {
      port.postMessage({ type: 'hello', site: SITE, version: VERSION });
    } catch {
      /* ignore */
    }
  }

  function scheduleReconnect() {
    if (state.reconnecting) return;
    state.reconnecting = true;
    setTimeout(() => {
      state.reconnecting = false;
      connect();
    }, 1500);
  }

  document.addEventListener('visibilitychange', () => {
    if (!state.port && document.visibilityState === 'visible') connect();
  });
  window.addEventListener('focus', () => {
    if (!state.port) connect();
  });
  window.addEventListener('pageshow', () => {
    if (!state.port) connect();
  });

  connect();
})();
