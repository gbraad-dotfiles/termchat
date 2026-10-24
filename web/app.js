'use strict';

/*
 * Browser client for the termchat bridge. It uses the same endpoints as the
 * CLI: POST /v1/request, then long-poll GET /v1/state/<id>. The extension
 * does the actual work in a signed-in chat tab.
 */
(() => {
  const SITES = {
    gemini: { label: 'Gemini', placeholder: 'Ask Gemini...' },
    copilot: { label: 'Copilot', placeholder: 'Ask Copilot...' },
    deepseek: { label: 'DeepSeek', placeholder: 'Ask DeepSeek...' },
  };
  const STORAGE_KEY = 'termchat.web.v1';
  const MAX_ITEMS = 40;
  const STATUS_EVERY = 5000;
  const { markdown } = window.TermchatMarkdown;

  // ---- stored state ----------------------------------------------------

  function stored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : {};
    } catch (_) {
      return {};
    }
  }

  function normalizeThreads(source) {
    const threads = {};
    for (const site of Object.keys(SITES)) {
      const list = source && Array.isArray(source[site]) ? source[site] : [];
      threads[site] = list
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .slice(-MAX_ITEMS)
        .map((item) => ({
          role: item.role,
          text: typeof item.text === 'string' ? item.text : '',
          markdown: typeof item.markdown === 'string' ? item.markdown : '',
          state: item.role === 'user' ? 'done' : item.state || 'done',
          error: typeof item.error === 'string' ? item.error : '',
          jobId: typeof item.jobId === 'string' ? item.jobId : '',
          at: Number(item.at) || 0,
          startedAt: Number(item.startedAt) || 0,
          finishedAt: Number(item.finishedAt) || 0,
          queuedAhead: Number(item.queuedAhead) || 0,
        }));
    }
    return threads;
  }

  const saved = stored();
  const state = {
    site: SITES[saved.site] ? saved.site : 'gemini',
    newChat: typeof saved.newChat === 'boolean' ? saved.newChat : true,
    token: typeof saved.token === 'string' ? saved.token : '',
    needToken: false,
    sending: {},
    threads: normalizeThreads(saved.threads),
  };

  // Items that were interrupted while the page was closed cannot be resumed
  // when they never reached the server.
  for (const list of Object.values(state.threads)) {
    for (const item of list) {
      if (item.role === 'assistant' && !item.jobId && item.state !== 'done') {
        item.state = 'done';
        item.error = 'interrupted before it was sent';
        item.finishedAt = Date.now();
      }
    }
  }

  let saveTimer = 0;
  let tokenResolve = null;
  let tokenBusy = false;

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      const threads = {};
      for (const [site, list] of Object.entries(state.threads)) {
        threads[site] = list.slice(-MAX_ITEMS).map((item) => ({
          role: item.role,
          text: item.text || '',
          markdown: item.markdown || '',
          state: item.state || 'done',
          error: item.error || '',
          jobId: item.jobId || '',
          at: item.at || 0,
          startedAt: item.startedAt || 0,
          finishedAt: item.finishedAt || 0,
          queuedAhead: item.queuedAhead || 0,
        }));
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          site: state.site,
          newChat: state.newChat,
          token: state.token,
          threads,
        })
      );
    } catch (_) {
      // Storage can be unavailable (private window, quota). The page still works.
    }
  }

  function persistSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 400);
  }

  // ---- DOM -------------------------------------------------------------

  const main = document.getElementById('main');
  const thread = document.getElementById('thread');
  const empty = document.getElementById('empty');
  const tabButtons = Array.from(document.querySelectorAll('.site-tab'));
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusVersion = document.getElementById('status-version');
  const newChatBox = document.getElementById('new-chat');
  const prompt = document.getElementById('prompt');
  const sendButton = document.getElementById('send');
  const composer = document.getElementById('composer');
  const hint = document.getElementById('hint');
  const tokenButton = document.getElementById('token-button');
  const tokenDialog = document.getElementById('token-dialog');
  const tokenInput = document.getElementById('token-input');
  const tokenForm = document.getElementById('token-form');
  const tokenCancel = document.getElementById('token-cancel');

  // ---- helpers ---------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isCanceled(item) {
    return item.state === 'done' && /^canceled\b/i.test(item.error || '');
  }

  function isBusy(site) {
    if (state.sending[site]) return true;
    return (state.threads[site] || []).some(
      (item) =>
        item.role === 'assistant' && Boolean(item.jobId) && item.state !== 'done'
    );
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total >= 3600) return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
    if (total >= 60) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
    return `${total}s`;
  }

  // ---- API -------------------------------------------------------------

  function requestHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['X-Termchat-Token'] = state.token;
    return headers;
  }

  async function apiFetch(path, options) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (_) {
      const error = new Error('server unreachable');
      error.status = 0;
      throw error;
    }
    const type = response.headers.get('Content-Type') || '';
    let body = null;
    if (type.includes('application/json')) {
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
    }
    if (!response.ok) {
      const error = new Error((body && body.error) || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function apiGet(path) {
    return apiFetch(path, { headers: requestHeaders() });
  }

  function apiPost(path, payload) {
    return apiFetch(path, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify(payload || {}),
    });
  }

  function askToken() {
    if (tokenBusy) {
      return new Promise((resolve) => {
        const wait = setInterval(() => {
          if (!tokenBusy) {
            clearInterval(wait);
            resolve(state.token || '');
          }
        }, 100);
      });
    }
    tokenBusy = true;
    tokenInput.value = state.token || '';
    return new Promise((resolve) => {
      tokenResolve = resolve;
      if (typeof tokenDialog.showModal === 'function') {
        tokenDialog.showModal();
        tokenInput.focus();
        tokenInput.select();
      } else {
        const value = window.prompt('Access token');
        closeToken(value ? value.trim() : '');
      }
    });
  }

  function closeToken(value) {
    const resolve = tokenResolve;
    tokenResolve = null;
    tokenBusy = false;
    if (tokenDialog.open && typeof tokenDialog.close === 'function') {
      tokenDialog.close();
    }
    if (resolve) resolve(value || '');
  }

  async function withTokenRetry(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!error || error.status !== 401) throw error;
      state.needToken = true;
      tokenButton.hidden = false;
      const token = await askToken();
      if (!token) throw error;
      state.token = token;
      state.needToken = false;
      saveNow();
      return fn();
    }
  }

  // ---- rendering -------------------------------------------------------

  function setStatus(kind, text, version) {
    statusDot.className = `dot ${kind}`;
    statusText.textContent = text;
    statusVersion.textContent = version || '';
  }

  function renderTabs() {
    document.title = `termchat · ${SITES[state.site].label}`;
    for (const button of tabButtons) {
      const site = button.dataset.site;
      const active = site === state.site;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('active', active);
      const busy = isBusy(site);
      let dot = button.querySelector('.busy-dot');
      if (busy && !dot) {
        dot = document.createElement('span');
        dot.className = 'busy-dot';
        dot.setAttribute('aria-hidden', 'true');
        button.appendChild(dot);
      } else if (!busy && dot) {
        dot.remove();
      }
    }
  }

  function updateComposer() {
    const busy = isBusy(state.site);
    sendButton.disabled = busy || !prompt.value.trim();
    sendButton.textContent = busy ? 'Wait' : 'Send';
    prompt.placeholder = SITES[state.site].placeholder;
    if (busy) {
      hint.textContent = 'Waiting for the answer...';
      hint.classList.add('busy');
    } else if (newChatBox.checked && (state.threads[state.site] || []).length) {
      hint.textContent = 'The next message starts a new chat';
      hint.classList.add('busy');
    } else {
      hint.textContent = 'Enter to send, Shift+Enter for a new line';
      hint.classList.remove('busy');
    }
  }

  function statusTextFor(item) {
    if (item.state === 'done') return isCanceled(item) ? 'canceled' : 'finished';
    if (item.state === 'pending') {
      return item.queuedAhead > 0
        ? `queued, ${item.queuedAhead} ahead`
        : 'waiting for the browser tab';
    }
    if (item.text) return 'streaming';
    return 'answering';
  }

  function elapsedNode(item) {
    const span = document.createElement('span');
    span.className = 'elapsed';
    if (item.startedAt) {
      span.dataset.start = String(item.startedAt);
      if (item.state === 'done' && item.finishedAt) {
        span.dataset.end = String(item.finishedAt);
      }
      span.textContent = formatDuration(
        (item.state === 'done' && item.finishedAt ? item.finishedAt : Date.now()) -
          item.startedAt
      );
    }
    return span;
  }

  function renderItem(item) {
    const failed = Boolean(item.error) && !isCanceled(item);
    const article = document.createElement('article');
    article.className = 'msg';
    if (item.role === 'user') {
      article.classList.add('user');
    } else {
      article.classList.add('assistant');
      if (failed) article.classList.add('error');
    }

    const label = document.createElement('div');
    label.className = 'label';
    const name = document.createElement('span');
    if (item.role === 'user') {
      name.textContent = 'You';
    } else if (failed) {
      name.textContent = `${SITES[state.site].label} error`;
    } else {
      name.textContent = SITES[state.site].label;
    }
    label.appendChild(name);
    if (item.role === 'assistant' && item.startedAt) {
      label.appendChild(elapsedNode(item));
    }
    article.appendChild(label);

    const body = document.createElement('div');
    body.className = 'body';
    if (item.role === 'user') {
      body.textContent = item.text;
    } else if (failed) {
      body.textContent = item.error;
    } else if (item.markdown && item.markdown.trim()) {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = markdown(item.markdown);
      body.appendChild(md);
    } else if (item.text) {
      const pre = document.createElement('pre');
      pre.className = 'stream';
      pre.textContent = item.text;
      if (item.state !== 'done') {
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        cursor.setAttribute('aria-hidden', 'true');
        pre.appendChild(cursor);
      }
      body.appendChild(pre);
    } else if (item.state === 'done') {
      body.textContent = isCanceled(item)
        ? '(no answer before it was stopped)'
        : '(no answer text)';
    }
    article.appendChild(body);

    if (item.role === 'assistant' && (item.state !== 'done' || isCanceled(item))) {
      const line = document.createElement('div');
      line.className = 'state-line';
      if (item.state !== 'done') {
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        spinner.setAttribute('aria-hidden', 'true');
        line.appendChild(spinner);
      }
      const text = document.createElement('span');
      text.textContent = statusTextFor(item);
      line.appendChild(text);
      if (item.state !== 'done' && item.jobId) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'stop';
        stop.textContent = 'Stop';
        stop.addEventListener('click', () => cancelJob(item));
        line.appendChild(stop);
      }
      article.appendChild(line);
    }

    return article;
  }

  function render(forceScroll) {
    const list = state.threads[state.site] || [];
    const nearBottom =
      main.scrollHeight - main.scrollTop - main.clientHeight < 140;
    empty.hidden = list.length > 0;
    thread.replaceChildren();
    for (const item of list) thread.appendChild(renderItem(item));
    renderTabs();
    updateComposer();
    if (forceScroll || nearBottom) main.scrollTop = main.scrollHeight;
  }

  function updateElapsed() {
    for (const node of document.querySelectorAll('.elapsed[data-start]')) {
      const start = Number(node.dataset.start);
      const end = Number(node.dataset.end);
      if (!start) continue;
      node.textContent = formatDuration((end || Date.now()) - start);
    }
  }

  // ---- actions ---------------------------------------------------------

  function autosize() {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`;
  }

  async function cancelJob(item) {
    try {
      await withTokenRetry(() =>
        apiPost(`/v1/request/${encodeURIComponent(item.jobId)}/cancel`, {})
      );
    } catch (error) {
      if (error && error.status === 404) return;
    }
  }

  async function watchJob(site, item) {
    let after = -1;
    let failures = 0;
    for (;;) {
      const list = state.threads[site] || [];
      if (!list.includes(item)) return;

      let snapshot;
      try {
        snapshot = await withTokenRetry(async () => {
          try {
            return await apiGet(
              `/v1/state/${encodeURIComponent(item.jobId)}?after=${after}&wait=10`
            );
          } catch (error) {
            if (error && error.status === 404) return null;
            throw error;
          }
        });
        failures = 0;
      } catch (error) {
        if (error && error.status === 401) {
          item.state = 'done';
          item.error = 'a valid token is needed to read this answer';
          item.finishedAt = Date.now();
          break;
        }
        failures += 1;
        if (failures >= 4) {
          item.state = 'done';
          item.error = 'lost contact with the server';
          item.finishedAt = Date.now();
          break;
        }
        await sleep(700 * failures);
        continue;
      }

      if (!snapshot) {
        item.state = 'done';
        item.error = 'the server no longer knows this job (was it restarted?)';
        item.finishedAt = Date.now();
        break;
      }

      if (typeof snapshot.seq === 'number') after = snapshot.seq;
      if (snapshot.state) item.state = snapshot.state;
      item.queuedAhead = Number(snapshot.queued_ahead) || 0;
      if (typeof snapshot.text === 'string' && snapshot.text) {
        item.text = snapshot.text;
      }
      if (typeof snapshot.markdown === 'string') {
        item.markdown = snapshot.markdown;
      }
      if (snapshot.error) {
        item.error = snapshot.error;
      } else if (snapshot.state !== 'done') {
        item.error = '';
      }

      render();
      persistSoon();
      if (snapshot.state === 'done') break;
    }

    item.finishedAt = Date.now();
    if (state.site === site) render();
    persistSoon();
  }

  async function sendPrompt() {
    const site = state.site;
    const text = prompt.value.trim();
    if (!text || isBusy(site)) return;

    const newChat = Boolean(newChatBox.checked);
    const userItem = { role: 'user', text, at: Date.now(), state: 'done' };
    if (!Array.isArray(state.threads[site])) state.threads[site] = [];
    state.threads[site].push(userItem);
    if (newChat) state.threads[site] = [userItem];

    const answer = {
      role: 'assistant',
      text: '',
      markdown: '',
      state: 'pending',
      error: '',
      jobId: '',
      startedAt: Date.now(),
      finishedAt: 0,
      queuedAhead: 0,
    };
    state.threads[site].push(answer);
    state.sending[site] = true;
    state.newChat = newChat;

    prompt.value = '';
    autosize();
    render(true);
    saveNow();

    try {
      const created = await withTokenRetry(() =>
        apiPost('/v1/request', {
          site,
          prompt: text,
          new_chat: newChat,
          timeout: 600,
        })
      );
      answer.jobId = created && created.id ? created.id : '';
      state.sending[site] = false;
      newChatBox.checked = false;
      state.newChat = false;
      render();
      saveNow();
      if (answer.jobId) {
        watchJob(site, answer);
      } else {
        answer.state = 'done';
        answer.error = 'the server did not return a job id';
        answer.finishedAt = Date.now();
        render();
      }
    } catch (error) {
      state.sending[site] = false;
      answer.state = 'done';
      answer.finishedAt = Date.now();
      if (error && error.status === 401) {
        answer.error = 'the server requires a valid token';
      } else if (error && error.status === 403) {
        answer.error = 'the server rejected this page (origin not allowed)';
      } else {
        answer.error = (error && error.message) || 'could not reach the server';
      }
      render();
      saveNow();
    }
  }

  // ---- status ----------------------------------------------------------

  async function refreshStatus() {
    const label = SITES[state.site].label;
    try {
      const info = await apiGet('/v1/ping?probe=client');
      const ages = info && info.poll_ages ? info.poll_ages : {};
      const known = Object.prototype.hasOwnProperty.call(ages, state.site);
      const age = known ? Number(ages[state.site]) : null;
      const version = info && info.extension_version ? `v${info.extension_version}` : '';
      const active = (state.threads[state.site] || []).find(
        (item) => item.role === 'assistant' && item.state === 'running'
      );
      if (active) {
        // The worker stops polling while it drives a job, so the poll age
        // would otherwise read as "idle" for the duration of the answer.
        setStatus('ok', `${label} answering`, version);
        return;
      }
      if (age !== null && Number.isFinite(age) && age <= 12) {
        setStatus('ok', `${label} tab ready`, version);
      } else if (age !== null) {
        setStatus('warn', `${label} tab idle ${Math.round(age)}s`, version);
      } else if (Object.keys(ages).length) {
        setStatus('warn', `${label} tab not polling`, version);
      } else {
        setStatus('warn', 'no extension polling', version);
      }
    } catch (error) {
      setStatus('bad', error && error.status === 0 ? 'server unreachable' : 'server error', '');
    }
  }

  // ---- events ----------------------------------------------------------

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      if (button.dataset.site === state.site) return;
      state.site = button.dataset.site;
      saveNow();
      render(true);
      refreshStatus();
      prompt.focus();
    });
  }

  prompt.addEventListener('input', () => {
    autosize();
    updateComposer();
  });

  prompt.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (!sendButton.disabled) composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendPrompt();
  });

  newChatBox.addEventListener('change', () => {
    state.newChat = newChatBox.checked;
    updateComposer();
    saveNow();
  });

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      prompt.value = chip.dataset.prompt || '';
      autosize();
      prompt.focus();
      updateComposer();
    });
  }

  tokenButton.addEventListener('click', async () => {
    const value = await askToken();
    if (value) {
      state.token = value;
      state.needToken = false;
      tokenButton.hidden = false;
      saveNow();
      refreshStatus();
    }
  });

  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = tokenInput.value.trim();
    state.token = value;
    state.needToken = false;
    tokenButton.hidden = !value;
    saveNow();
    closeToken(value);
  });

  tokenCancel.addEventListener('click', () => closeToken(''));

  tokenDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeToken('');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshStatus();
  });

  window.addEventListener('pagehide', saveNow);

  // ---- start -----------------------------------------------------------

  newChatBox.checked = state.newChat;
  tokenButton.hidden = !state.token && !state.needToken;
  autosize();
  render(true);
  updateElapsed();
  refreshStatus();
  setInterval(updateElapsed, 1000);
  setInterval(refreshStatus, STATUS_EVERY);

  // Resume jobs that were still running when the page was closed or reloaded.
  for (const [site, list] of Object.entries(state.threads)) {
    for (const item of list) {
      if (item.role === 'assistant' && item.jobId && item.state !== 'done') {
        watchJob(site, item);
      }
    }
  }
})();
