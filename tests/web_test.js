#!/usr/bin/env node
/* Checks for the web UI's Markdown renderer and its HTML-escaping rules.
 * Runs the same web/markdown.js the browser loads, without a DOM. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'web', 'markdown.js'), 'utf8'),
  sandbox,
  { filename: 'markdown.js' }
);

const md = sandbox.window.TermchatMarkdown;
let failures = 0;

function check(name, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

function includes(name, source, needle) {
  const out = md.markdown(source);
  check(name, out.includes(needle), `missing ${JSON.stringify(needle)} in ${JSON.stringify(out)}`);
  return out;
}

if (!md || typeof md.markdown !== 'function') {
  console.error('markdown.js did not export TermchatMarkdown.markdown');
  process.exit(1);
}

check(
  'escapeHtml',
  md.escapeHtml('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;',
  md.escapeHtml('<b>&"\'')
);

includes('bold', '**bold**', '<strong>bold</strong>');
includes('italic', 'an *italic* word', '<em>italic</em>');
includes('inline code', 'use `code` now', '<code>code</code>');

const rawHtml = md.markdown('<img src=x onerror="alert(1)">');
check(
  'raw html is escaped',
  rawHtml.includes('&lt;img') && !rawHtml.includes('<img'),
  rawHtml
);

const xssLink = md.markdown('[click](javascript:alert(1))');
check(
  'javascript links are not links',
  !xssLink.includes('<a ') && !xssLink.includes('href='),
  xssLink
);

const fence = md.markdown('```html\n<script>alert(1)</script>\n```\n');
check(
  'fenced code is escaped',
  fence.includes('<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'),
  fence
);
check('fenced code adds no script tag', !fence.includes('<script>'), fence);

const unclosed = md.markdown('```\nlet x = 1;');
check(
  'unclosed fence still renders',
  unclosed.includes('<pre><code>let x = 1;</code></pre>'),
  unclosed
);

const link = md.markdown('[docs](https://example.com/a?b=1)');
check(
  'https link',
  link.includes('href="https://example.com/a?b=1"') &&
    link.includes('rel="noopener noreferrer"'),
  link
);

const ul = md.markdown('- one\n- two\n');
check(
  'unordered list',
  ul.includes('<ul><li>one</li><li>two</li></ul>'),
  ul
);

const ol = md.markdown('1. first\n2. second\n');
check(
  'ordered list',
  ol.includes('<ol><li>first</li><li>second</li></ol>'),
  ol
);

includes('heading', '# Title', '<h1>Title</h1>');
includes('deep heading', '#### Deep', '<h4>Deep</h4>');
includes('rule', '---', '<hr>');

const table = md.markdown('| A | B |\n| --- | ---: |\n| 1 | 2 |\n');
check(
  'table',
  table.includes('<table>') &&
    table.includes('<th>A</th>') &&
    table.includes('style="text-align:right"') &&
    table.includes('<td>1</td>'),
  table
);

const quote = md.markdown('> hello\n> world');
check(
  'blockquote',
  quote.includes('<blockquote><p>hello<br>world</p></blockquote>'),
  quote
);

const codeMarkers = md.markdown('`a*b*c`');
check(
  'code span protects markers',
  codeMarkers.includes('<code>a*b*c</code>') && !codeMarkers.includes('<em>'),
  codeMarkers
);

const snake = md.markdown('some_var_here');
check(
  'snake_case is not italic',
  snake === '<p>some_var_here</p>',
  snake
);

const lines = md.markdown('line one\nline two');
check(
  'paragraph keeps line breaks',
  lines.includes('<p>line one<br>line two</p>'),
  lines
);

const alpha = md.markdown('| a |\n| --- |\n| <b>x</b> |\n');
check('table cells are escaped', alpha.includes('&lt;b&gt;x&lt;/b&gt;'), alpha);

// The page and the script must agree on element ids, and the renderer has to
// be loaded before app.js uses it.
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const usedIds = new Set(
  [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])
);
for (const id of usedIds) {
  check(`element #${id} exists`, ids.has(id), `ids: ${[...ids].join(', ')}`);
}

const classes = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((match) =>
    match[1].split(/\s+/).filter(Boolean)
  )
);
for (const name of ['site-tab', 'chip', 'composer', 'status']) {
  check(`class .${name} exists`, classes.has(name));
}

const rendererAt = html.indexOf('/markdown.js');
const appAt = html.indexOf('/app.js');
check('markdown.js loads before app.js', rendererAt !== -1 && appAt > rendererAt);

if (failures) {
  console.error(`${failures} web renderer check(s) failed`);
  process.exit(1);
}
process.exit(0);
