'use strict';

/* Loads extension/content.js against a tiny fake DOM and checks that the
 * answer serializer keeps Markdown structure. Run: node tests/content_test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.__TERMCHAT_TEST__ = true;

function textNode(value) {
  return { nodeType: 3, textContent: String(value), parentElement: null };
}

function textOf(node) {
  if (node.nodeType === 3) return node.textContent;
  return node.childNodes.map(textOf).join('');
}

function collect(node, selector, out) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    if (
      selector === '*' ||
      (selector === 'tr' && child.tagName === 'TR') ||
      (selector === 'code' && child.tagName === 'CODE')
    ) {
      out.push(child);
    }
    collect(child, selector, out);
    if (child.shadowRoot) collect(child.shadowRoot, selector, out);
  }
  return out;
}

function el(tagName, attrs, children) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: [],
    children: [],
    parentElement: null,
    shadowRoot: null,
    hidden: false,
    isConnected: true,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs || {}, name)
        ? attrs[name]
        : null;
    },
    querySelectorAll(selector) {
      return collect(node, selector, []);
    },
  };
  Object.defineProperty(node, 'textContent', { get: () => textOf(node) });
  Object.defineProperty(node, 'innerText', { get: () => textOf(node) });
  for (const child of children || []) {
    child.parentElement = node;
    node.childNodes.push(child);
    if (child.nodeType === 1) node.children.push(child);
  }
  return node;
}

function text(value) {
  return textNode(value);
}

globalThis.document = {
  addEventListener() {},
  visibilityState: 'visible',
  querySelectorAll() {
    return [];
  },
};
globalThis.window = { addEventListener() {} };
globalThis.location = {
  hostname: 'gemini.google.com',
  href: 'https://gemini.google.com/app/1',
};
globalThis.chrome = {
  runtime: {
    connect() {
      return {
        postMessage() {},
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
      };
    },
  },
};

const source = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content.js'),
  'utf8'
);
vm.runInThisContext(source, { filename: 'content.js' });

const serializer = globalThis.__termchatTest;
assert.ok(serializer, 'content.js did not expose its test hook');

const pre = el('pre', {}, [
  el('code', { class: 'language-python' }, [
    text('def f():\n    return 1'),
  ]),
]);

const table = el('table', {}, [
  el('thead', {}, [
    el('tr', {}, [el('th', {}, [text('a')]), el('th', {}, [text('b')])]),
  ]),
  el('tbody', {}, [
    el('tr', {}, [el('td', {}, [text('1')]), el('td', {}, [text('2')])]),
  ]),
]);

const answer = el('message-content', {}, [
  el('h2', {}, [text('Title')]),
  el('p', {}, [
    text('Hello '),
    el('strong', {}, [text('world')]),
    text(' and '),
    el('code', {}, [text('x = 1')]),
    text('.'),
  ]),
  el('ul', {}, [
    el('li', {}, [text('one')]),
    el('li', {}, [
      text('two'),
      el('ul', {}, [el('li', {}, [text('nested')])]),
    ]),
  ]),
  pre,
  table,
]);

const markdown = serializer.deepMarkdown(answer);

assert.match(markdown, /^## Title$/m, 'heading');
assert.match(markdown, /\*\*world\*\*/, 'bold');
assert.match(markdown, /`x = 1`/, 'inline code');
assert.match(markdown, /^- one$/m, 'list item');
assert.match(markdown, /^- two\n {2}- nested$/m, 'nested list');
assert.match(
  markdown,
  /```python\ndef f\(\):\n {4}return 1\n```/,
  'fenced code keeps indentation'
);
assert.match(markdown, /\| a \| b \|/, 'table header');
assert.match(markdown, /\| 1 \| 2 \|/, 'table row');

const cleaned = serializer.tidyMarkdown('# A\n\n\n\ntext\n');
assert.strictEqual(cleaned, '# A\n\ntext', 'blank lines collapsed');

console.log('content: markdown extraction OK');
