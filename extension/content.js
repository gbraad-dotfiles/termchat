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

  // The worker may inject this file into tabs that were already open when the
  // extension was installed or reloaded. Do not start a second session of the
  // same build. A newer build may take over a tab that still runs an older
  // content script; the worker then ignores the stale port.
  const BUILD = '0.1.5';
  if (globalThis.__termchatContentBuild === BUILD) {
    const live = globalThis.__termchatContentPort;
    if (!globalThis.__termchatContentDead && live) {
      try {
        // This also wakes the worker if it was suspended. A throw means the
        // port belongs to an extension context that no longer exists (the
        // extension was reloaded), so this injection takes the tab over.
        live.postMessage({ type: 'hello', version: BUILD });
        return;
      } catch {
        /* orphaned content script; start a fresh session below */
      }
    } else if (!globalThis.__termchatContentDead) {
      // The live session is between reconnects; its timer will connect again.
      return;
    }
  }
  globalThis.__termchatContentBuild = BUILD;
  globalThis.__termchatContentDead = false;

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.connect) return;

  const SITE = {
    'gemini.google.com': 'gemini',
    'copilot.microsoft.com': 'copilot',
    'chat.deepseek.com': 'deepseek',
  }[location.hostname];
  if (!SITE) return;

  const VERSION = BUILD;

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
    lastCommandAt: 0,
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

  // Sent back with every reply so the worker's diagnostics show what the page
  // itself sees while a job is running.
  function env() {
    return {
      vis: document.visibilityState,
      focus: document.hasFocus(),
      w: window.innerWidth,
      h: window.innerHeight,
    };
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

  /* ------------------------------------------------------------------ */
  /* answer -> Markdown                                                 */
  /* ------------------------------------------------------------------ */

  // The page renders Markdown to HTML before we see it. Walk that HTML back
  // to Markdown so the CLI can keep the answer's structure (headings, lists,
  // code blocks, emphasis) instead of flattening it to plain text.
  const MD_SKIP =
    /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|BUTTON|INPUT|TEXTAREA|SELECT|OPTION|MAT-ICON|VECTOR|USE)$/;
  const MD_BLOCK =
    /^(ADDRESS|ARTICLE|ASIDE|DIV|DL|DD|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|LI|MAIN|NAV|OL|P|SECTION|UL)$/;

  function mdHidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cls = el.getAttribute('class') || '';
    return /\b(hidden|sr-only|visually-hidden)\b/.test(cls);
  }

  function mdCodeText(node) {
    if (!node.shadowRoot) return node.innerText ?? node.textContent ?? '';
    let out = '';
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent || '';
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (n.tagName === 'BR') {
        out += '\n';
        return;
      }
      const kids = n.shadowRoot ? n.shadowRoot.childNodes : n.childNodes;
      for (const child of kids) walk(child);
    };
    walk(node);
    return out;
  }

  function mdLanguage(node) {
    for (const el of [node, ...node.querySelectorAll('*')].slice(0, 30)) {
      for (const attr of ['data-language', 'data-lang']) {
        const value = el.getAttribute(attr);
        if (value) return String(value).trim().split(/\s+/)[0];
      }
      const match = /(?:language|lang)-([\w#+.-]+)/.exec(el.getAttribute('class') || '');
      if (match) return match[1];
    }
    return '';
  }

  function mdFind(node, tag) {
    const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    for (const child of kids) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === tag) return child;
      const found = mdFind(child, tag);
      if (found) return found;
    }
    return null;
  }

  function tidyMarkdown(markdown) {
    const lines = String(markdown || '')
      .replace(/\u00a0/g, ' ')
      .split('\n');
    const out = [];
    let fence = false;
    let blanks = 0;
    for (let line of lines) {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        blanks = 0;
        out.push(line.replace(/[ \t]+$/, ''));
        continue;
      }
      if (fence) {
        out.push(line);
        continue;
      }
      line = line.replace(/[ \t]+$/, '');
      if (!line.trim()) {
        blanks += 1;
        if (blanks <= 1) out.push('');
        continue;
      }
      blanks = 0;
      out.push(line);
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }

  function deepMarkdown(el) {
    if (!el) return '';
    const chunks = [];
    const push = (value) => {
      if (value) chunks.push(value);
    };
    const lineBreaks = (count) => {
      const last = chunks.length ? chunks[chunks.length - 1] : '';
      const have = (last.match(/\n*$/) || [''])[0].length;
      if (have < count) push('\n'.repeat(count - have));
    };
    const capture = (fn) => {
      const start = chunks.length;
      fn();
      return chunks.splice(start).join('');
    };
    const words = (value) => {
      const clean = String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
      if (!clean.trim()) {
        if (clean && chunks.length) push(' ');
        return;
      }
      push(clean);
    };
    const emphasis = (node, marker, depth) => {
      const raw = capture(() => renderChildren(node, depth));
      const body = raw.trim();
      if (!body) return;
      push((/^\s/.test(raw) ? ' ' : '') + marker + body + marker + (/\s$/.test(raw) ? ' ' : ''));
    };
    const table = (node) => {
      const rows = [];
      for (const tr of node.querySelectorAll('tr')) {
        const cells = [...tr.children].filter((cell) =>
          /^(TD|TH)$/.test(cell.tagName)
        );
        if (!cells.length) continue;
        rows.push(cells.map((cell) => flat(deepText(cell)).replace(/\|/g, '\\|')));
      }
      if (!rows.length) return;
      const columns = Math.max(...rows.map((row) => row.length));
      lineBreaks(2);
      rows.forEach((row, index) => {
        while (row.length < columns) row.push('');
        push(`| ${row.join(' | ')} |`);
        lineBreaks(1);
        if (index === 0) {
          push(`| ${row.map(() => '---').join(' | ')} |`);
          lineBreaks(1);
        }
      });
      lineBreaks(2);
    };

    function renderChildren(parent, depth) {
      const kids = parent.shadowRoot ? parent.shadowRoot.childNodes : parent.childNodes;
      for (const child of kids) render(child, depth);
    }

    function render(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        words(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (MD_SKIP.test(node.tagName) || mdHidden(node)) return;

      const tag = node.tagName;

      if (tag === 'BR') {
        push('\n');
        return;
      }

      // Gemini wraps code in a custom element whose header holds the language
      // and a copy button. Render only the pre it contains.
      if (/^CODE-?BLOCK$/.test(tag)) {
        const pre = mdFind(node, 'PRE');
        if (pre) {
          render(pre, depth);
          return;
        }
      }

      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        lineBreaks(2);
        push('#'.repeat(level) + ' ');
        renderChildren(node, depth);
        lineBreaks(2);
        return;
      }

      if (tag === 'PRE') {
        const code = mdFind(node, 'CODE') || node;
        const language = mdLanguage(node) || mdLanguage(code);
        const body = mdCodeText(code).replace(/\n+$/, '');
        lineBreaks(2);
        push('```' + language + '\n' + body);
        lineBreaks(1);
        push('```');
        lineBreaks(2);
        return;
      }

      if (tag === 'CODE') {
        const value = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) return;
        let longest = 0;
        for (const run of value.match(/`+/g) || []) longest = Math.max(longest, run.length);
        const ticks = '`'.repeat(longest + 1);
        push(ticks + value + ticks);
        return;
      }

      if (tag === 'STRONG' || tag === 'B') {
        emphasis(node, '**', depth);
        return;
      }
      if (tag === 'EM' || tag === 'I') {
        emphasis(node, '*', depth);
        return;
      }
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
        emphasis(node, '~~', depth);
        return;
      }

      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        const raw = capture(() => renderChildren(node, depth));
        const label = raw.trim() || href;
        if (!label) return;
        if (!/^(https?:|mailto:)/i.test(href)) {
          push((/^\s/.test(raw) ? ' ' : '') + label);
          return;
        }
        push((/^\s/.test(raw) ? ' ' : '') + `[${label}](${href})`);
        if (/\s$/.test(raw)) push(' ');
        return;
      }

      if (tag === 'LI') {
        lineBreaks(1);
        let marker = '- ';
        const parent = node.parentElement;
        if (parent && parent.tagName === 'OL') {
          const items = [...parent.children].filter((item) => item.tagName === 'LI');
          const start = Number(parent.getAttribute('start') || 1) || 1;
          marker = `${start + items.indexOf(node)}. `;
        }
        push('  '.repeat(depth) + marker);
        const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
        for (const child of kids) {
          if (
            child.nodeType === Node.ELEMENT_NODE &&
            (child.tagName === 'UL' || child.tagName === 'OL')
          ) {
            render(child, depth + 1);
          } else {
            render(child, depth);
          }
        }
        lineBreaks(1);
        return;
      }

      if (tag === 'UL' || tag === 'OL') {
        lineBreaks(1);
        renderChildren(node, depth);
        lineBreaks(2);
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        lineBreaks(2);
        const body = capture(() => renderChildren(node, depth)).trim();
        if (body) {
          push(
            body
              .split('\n')
              .map((line) => '> ' + line)
              .join('\n')
          );
        }
        lineBreaks(2);
        return;
      }

      if (tag === 'TABLE') {
        table(node);
        return;
      }

      if (tag === 'HR') {
        lineBreaks(2);
        push('---');
        lineBreaks(2);
        return;
      }

      if (tag === 'P') {
        lineBreaks(node.parentElement && node.parentElement.tagName === 'LI' ? 0 : 2);
        renderChildren(node, depth);
        lineBreaks(node.parentElement && node.parentElement.tagName === 'LI' ? 0 : 2);
        return;
      }

      // Custom elements often carry their content in a shadow root.
      if (node.shadowRoot) {
        renderChildren(node, depth);
        if (MD_BLOCK.test(tag)) lineBreaks(1);
        return;
      }

      for (const child of node.childNodes) render(child, depth);
      if (MD_BLOCK.test(tag)) lineBreaks(1);
    }

    render(el, 0);
    return tidyMarkdown(chunks.join(''));
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
    if (best) return best;
    // A background tab can report a zero-sized layout even though the editor
    // is there; fall back to the first connected candidate so typing and
    // submitting can still be attempted.
    for (const selector of selectors) {
      for (const el of deepQueryAll(selector)) {
        if (seen.has(el) || !el.isConnected) continue;
        if (el.disabled || el.readOnly) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        return el;
      }
    }
    return null;
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
        return { ready: false, newchat: true, ...env() };
      }
    }

    const composer = findComposer();
    if (!composer) return { ready: false, ...env() };
    const pre = responseSignature();

    if (composerHas(composer, state.prompt)) {
      state.composer = composer;
      return { ready: true, pre, typed: true, ...env() };
    }

    setComposer(composer, state.prompt);
    if (!composerHas(composer, state.prompt)) {
      return {
        ready: false,
        error: 'could not type the prompt into the message box (try --inspect)',
        ...env(),
      };
    }
    state.composer = composer;
    return { ready: true, pre, typed: true, ...env() };
  }

  function submit() {
    const composer =
      state.composer && state.composer.isConnected ? state.composer : findComposer();
    if (!composer) return { submitted: false, empty: true, ...env() };
    if (composerEmpty(composer)) return { submitted: false, empty: true, ...env() };

    let how = 'button';
    let button = sendCandidates().find(usable);
    if (!button) {
      // The page may report a zero-sized button while the tab is hidden.
      // Click the real control anyway rather than falling back to Enter,
      // which these editors are more likely to ignore.
      for (const selector of adapter.send) {
        button = deepQueryAll(selector).find(
          (el) =>
            el.isConnected &&
            !el.disabled &&
            el.getAttribute('aria-disabled') !== 'true'
        );
        if (button) break;
      }
      if (button) how = 'button-hidden';
    }
    if (button) {
      button.click();
      return { submitted: true, how, ...env() };
    }
    pressEnter(composer);
    return { submitted: true, how: 'enter', ...env() };
  }

  function status() {
    const responses = collectResponses();
    const response = responses.length ? responses[responses.length - 1] : null;
    const composer =
      state.composer && state.composer.isConnected ? state.composer : findComposer();
    return {
      text: response ? tidy(deepText(response)) : '',
      markdown: response ? deepMarkdown(response) : '',
      count: responses.length,
      stop: Boolean(findStopButton()),
      promptInComposer: composer ? composerHas(composer, state.prompt) : false,
      url: location.href,
      ...env(),
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
    state.lastCommandAt = Date.now();
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

  // tests/content_test.js loads this file with a tiny fake DOM and calls the
  // serializer directly. Inert in a real tab.
  if (globalThis.__TERMCHAT_TEST__) {
    globalThis.__termchatTest = { deepMarkdown, tidyMarkdown };
  }

  function connect() {
    if (state.port) return;
    let port;
    try {
      port = api.runtime.connect({ name: 'termchat' });
    } catch {
      // After an extension reload this context is dead and every call throws.
      // A later injection can use the flag to take the tab over.
      globalThis.__termchatContentDead = true;
      scheduleReconnect();
      return;
    }
    globalThis.__termchatContentDead = false;
    state.port = port;
    // `executeScript` may run this file again in the same tab. A later copy
    // uses this handle to tell a live session from an orphaned one.
    globalThis.__termchatContentPort = port;
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      // A newer port may already have replaced this one.
      if (state.port !== port) return;
      if (globalThis.__termchatContentPort === port) {
        globalThis.__termchatContentPort = null;
      }
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

  // A port message wakes a sleeping service worker. Send one periodically while
  // the page lives, so an idle tab does not silently stop polling; the worker's
  // alarm covers the periods when a hidden tab's timers are throttled.
  function hello() {
    if (!state.port) {
      connect();
      return;
    }
    try {
      state.port.postMessage({ type: 'hello', site: SITE, version: VERSION });
    } catch {
      state.port = null;
      connect();
    }
  }

  // After the worker was stopped, its end of the old port is gone. A fresh
  // connection is the only way to be sure hello reaches the new worker
  // instance. Do not do this while a job is actively exchanging commands.
  function wake() {
    const busy = state.jobId && Date.now() - state.lastCommandAt < 10000;
    if (busy) {
      hello();
      return;
    }
    const port = state.port;
    state.port = null;
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    }
    connect();
  }

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'termchat-wake') return undefined;
      wake();
      if (sendResponse) sendResponse({ ok: true, site: SITE });
      return true;
    });
  }

  setInterval(hello, 20000);

  // Chrome freezes hidden tabs after a few minutes, and a frozen tab cannot
  // answer the worker. Holding a Web Lock is one of the documented opt-outs
  // from freezing; it costs no CPU.
  const nav = globalThis.navigator;
  if (nav && nav.locks && nav.locks.request) {
    try {
      nav.locks
        .request('termchat-keepalive', { mode: 'shared' }, () => new Promise(() => {}))
        .catch(() => {});
    } catch {
      /* the API is unavailable in this context */
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
