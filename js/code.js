/* Code preview: how code looks when Fuzz shows his work on a card (the Warm Theme System's code style).
   13px / 20px, line numbers, one optional highlighted line marked by the accent, diffs with + and − signs
   as well as a tint, long lines scroll sideways, and a 44px Copy button that says Copied when done.
   Block: { lang: 'ts' | 'js' | 'json' | 'diff', base: 'ts' (for diffs), file, code, highlight (1-based line), note }
   Diff lines start with a space, + or −/-; Copy gives the new version (context and added lines). */
(function () {
  var esc = UI.esc;
  var reg = {};
  var LABEL = { ts: 'TypeScript', js: 'JavaScript', json: 'JSON', diff: 'Diff' };
  var KW = /^(async|await|function|const|let|var|return|if|else|for|while|new|import|from|export|class|extends|try|catch|throw|true|false|null|undefined|typeof|of|in|default|switch|case|break|continue|interface|type)$/;
  var COPY_ICON = 'M5.5 5.5 H12.5 V13 H5.5 Z M3.5 10.5 V3 H10';
  var DONE_ICON = 'M3 8.5 L6.5 12 L13 4.5';

  /* A small tokenizer: enough for TypeScript, JavaScript and JSON snippets. k keyword, s string, n number, f function, t type, p property, c comment. */
  function tokenize(src, lang) {
    var out = [], i = 0, n = src.length, prev = '', m;
    while (i < n) {
      var ch = src[i], rest = src.slice(i);
      if (lang !== 'json' && ch === '/' && src[i + 1] === '/') { out.push(['c', rest]); break; }
      if ((m = /^\s+/.exec(rest))) { out.push(['x', m[0]]); i += m[0].length; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        var j = i + 1; while (j < n && src[j] !== ch) { if (src[j] === '\\') j++; j++; }
        j = Math.min(j + 1, n);
        var isKey = lang === 'json' && /^\s*:/.test(src.slice(j));
        out.push([isKey ? 'p' : 's', src.slice(i, j)]); prev = ch; i = j; continue;
      }
      if ((m = /^\d[\d._]*/.exec(rest)) && !/[\w$]/.test(prev)) { out.push(['n', m[0]]); prev = '0'; i += m[0].length; continue; }
      if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
        var w = m[0], after = /^\s*(.)/.exec(src.slice(i + w.length)), nx = after ? after[1] : '', cls = 'x';
        if (KW.test(w)) cls = 'k';
        else if (nx === '(') cls = 'f';
        else if (/^[A-Z]/.test(w)) cls = 't';
        else if (prev === '.' || (nx === ':' && src[i + w.length + 1] !== ':')) cls = 'p';
        out.push([cls, w]); prev = 'a'; i += w.length; continue;
      }
      out.push(['x', ch]); prev = ch; i++;
    }
    return out;
  }
  function toks(tk) {
    return tk.map(function (t) { return t[0] === 'x' ? esc(t[1]) : '<span class="tk-' + t[0] + '">' + esc(t[1]) + '</span>'; }).join('');
  }
  function plain(rows) { return rows.join('\n'); }

  function html(b, key) {
    var lang = b.lang || 'ts', lines = String(b.code).replace(/\n$/, '').split('\n'), rows = '', copy;
    if (lang === 'diff') {
      var base = b.base || 'ts';
      copy = plain(lines.filter(function (l) { return l[0] !== '-' && l[0] !== '−'; }).map(function (l) { return l.slice(1); }));
      rows = lines.map(function (l) {
        var k = l[0] === '+' ? 'add' : (l[0] === '-' || l[0] === '−') ? 'rem' : '';
        var glyph = k === 'add' ? '+' : k === 'rem' ? '−' : '';
        return '<div class="code-row ' + k + '"><span class="code-gut">' + (k ? '<span class="sr">' + (k === 'add' ? 'Added: ' : 'Removed: ') + '</span>' + glyph : '') + '</span><span class="code-txt">' + toks(tokenize(l.slice(1), base)) + '</span></div>';
      }).join('');
    } else {
      copy = b.code.replace(/\n$/, '');
      rows = lines.map(function (l, i) {
        return '<div class="code-row' + (b.highlight === i + 1 ? ' hl' : '') + '"><span class="code-gut" aria-hidden="true">' + (i + 1) + '</span><span class="code-txt">' + toks(tokenize(l, lang)) + '</span></div>';
      }).join('');
    }
    reg[key] = copy;
    var file = b.file || '';
    return '<figure class="code"><div class="code-head"><div class="code-id"><span class="code-lang">' + esc(LABEL[lang === 'diff' ? (b.base || 'ts') : lang] || lang) + (lang === 'diff' ? ' diff' : '') + '</span>' +
      (file ? '<span class="code-file">' + esc(file) + '</span>' : '') + '</div>' +
      '<button type="button" class="code-copy" data-copy="' + esc(key) + '" aria-label="Copy ' + esc(file || 'code') + '"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="' + COPY_ICON + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span aria-live="polite">Copy</span></button></div>' +
      '<div class="code-body" tabindex="0" role="region" aria-label="Code: ' + esc(file || LABEL[lang] || 'snippet') + '">' + rows + '</div></figure>' +
      (b.note ? '<p class="code-note">' + UI.text(b.note) + '</p>' : '');
  }

  /* Every block on a task, as one stack. */
  function section(blocks, prefix) {
    return '<div class="codes">' + blocks.map(function (b, i) { return html(b, prefix + ':' + i); }).join('') + '</div>';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } t.remove();
    });
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-copy]'); if (!btn) return;
    var text = reg[btn.dataset.copy]; if (text == null) return;
    var orig = btn.innerHTML;
    copyText(text).then(function () {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="' + DONE_ICON + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span aria-live="polite">Copied</span>';
      setTimeout(function () { if (document.body.contains(btn)) btn.innerHTML = orig; }, 2000);
    }, function () {
      btn.querySelector('span').textContent = 'Press Ctrl+C';
      setTimeout(function () { if (document.body.contains(btn)) btn.innerHTML = orig; }, 2000);
    });
  });

  window.CodeView = { html: html, section: section, tokenize: tokenize };
})();
