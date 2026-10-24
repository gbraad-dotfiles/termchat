'use strict';

/*
 * Small, dependency-free Markdown renderer for answers coming from the chat
 * pages. Everything is HTML-escaped before any markup is added, and link URLs
 * are limited to http(s) and mailto. Exposed as window.TermchatMarkdown so
 * tests can run it in Node without a DOM.
 */
(function (root) {
  const ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(
      /[&<>"']/g,
      (char) => ESCAPES[char]
    );
  }

  function safeUrl(raw) {
    const url = String(raw || '').trim();
    if (/^https?:\/\/\S+$/i.test(url) || /^mailto:\S+$/i.test(url)) return url;
    return '';
  }

  function inline(raw) {
    const codes = [];
    const links = [];
    let text = String(raw == null ? '' : raw);
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000C${codes.length - 1}\u0000`;
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const href = safeUrl(url);
      if (!href) return match;
      links.push({ label, href });
      return `\u0000L${links.length - 1}\u0000`;
    });
    text = escapeHtml(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
    text = text.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
    text = text.replace(
      /\u0000C(\d+)\u0000/g,
      (_, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`
    );
    text = text.replace(/\u0000L(\d+)\u0000/g, (_, index) => {
      const link = links[Number(index)];
      return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`;
    });
    return text;
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function tableHtml(head, rows, align) {
    const cell = (tag, value, index) => {
      const style = align[index] ? ` style="text-align:${align[index]}"` : '';
      return `<${tag}${style}>${inline(value)}</${tag}>`;
    };
    const thead = `<thead><tr>${head.map((value, index) => cell('th', value, index)).join('')}</tr></thead>`;
    const tbody = rows.length
      ? `<tbody>${rows
          .map(
            (row) =>
              `<tr>${head.map((_, index) => cell('td', row[index] || '', index)).join('')}</tr>`
          )
          .join('')}</tbody>`
      : '';
    return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
  }

  function markdown(source) {
    let text = String(source || '').replace(/\r\n?/g, '\n');
    const fences = [];
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_, lang, body) => {
      fences.push({
        lang: String(lang || '').trim(),
        body: body.replace(/\n$/, ''),
      });
      return `\u0000F${fences.length - 1}\u0000\n`;
    });

    const lines = text.split('\n');
    const out = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        const items = list.items.map((item) => `<li>${inline(item)}</li>`).join('');
        out.push(`<${list.type}>${items}</${list.type}>`);
        list = null;
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fence = /^\u0000F(\d+)\u0000$/.exec(line.trim());
      if (fence) {
        flushParagraph();
        flushList();
        const block = fences[Number(fence[1])];
        const cls = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(block.body)}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const depth = Math.min(heading[1].length, 4);
        out.push(`<h${depth}>${inline(heading[2].trim())}</h${depth}>`);
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        flushList();
        out.push('<hr>');
        continue;
      }
      const separator = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
      if (line.includes('|') && i + 1 < lines.length && separator.test(lines[i + 1])) {
        flushParagraph();
        flushList();
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((cell) => {
          const value = cell.trim();
          if (/^:-+:$/.test(value)) return 'center';
          if (/^:-+$/.test(value)) return 'left';
          if (/^-+:$/.test(value)) return 'right';
          return '';
        });
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        i -= 1;
        out.push(tableHtml(head, rows, align));
        continue;
      }
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        flushList();
        const parts = [quote[1]];
        while (i + 1 < lines.length && /^>\s?(.*)$/.test(lines[i + 1])) {
          i += 1;
          parts.push(/^>\s?(.*)$/.exec(lines[i])[1]);
        }
        out.push(`<blockquote><p>${parts.map(inline).join('<br>')}</p></blockquote>`);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (!list || list.type !== 'ul') {
          flushList();
          list = { type: 'ul', items: [] };
        }
        list.items.push(bullet[1]);
        continue;
      }
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) {
        flushParagraph();
        if (!list || list.type !== 'ol') {
          flushList();
          list = { type: 'ol', items: [] };
        }
        list.items.push(numbered[1]);
        continue;
      }
      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return out.join('\n');
  }

  root.TermchatMarkdown = { escapeHtml, safeUrl, inline, markdown };
})(typeof window !== 'undefined' ? window : globalThis);
