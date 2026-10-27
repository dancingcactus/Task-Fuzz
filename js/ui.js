/* Small shared UI helpers. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /* Status chips use a tone, never red. Tones map to theme tokens in app.css. */
  /* Status colours always come with an icon (done, waiting, blocked), never colour alone. */
  var ICON_BASE = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" style="stroke:var(--tone)" stroke-width="1.8"/>';
  var STATUS_ICON = {
    ok: ICON_BASE + '<path d="M4.8 8.2 L7.1 10.5 L11.2 5.8" fill="none" style="stroke:var(--tone)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: ICON_BASE + '<path d="M8 4.2 V8 L10.6 9.6" fill="none" style="stroke:var(--tone)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    danger: ICON_BASE + '<path d="M5.2 5.2 L10.8 10.8 M10.8 5.2 L5.2 10.8" fill="none" style="stroke:var(--tone)" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  function pill(text, tone) {
    tone = tone || 'muted'; var ic = STATUS_ICON[tone];
    return '<span class="pill pill--' + tone + (ic ? ' pill--icon' : '') + '">' + (ic || '') + esc(text) + '</span>';
  }
  /* Escape text, then turn `backticked` bits into inline code. */
  function text(s) { return esc(s).replace(/`([^`]+)`/g, '<code class="icode">$1</code>'); }

  /* Markdown the AI writes, drawn as HTML. Escaped first, so only these few forms become markup. */
  function inline(s) {
    var codes = [];
    s = esc(s).replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(\*\*|__)(?=\S)(.+?)\1/g, '<strong>$2</strong>')
      .replace(/(^|[^*\w])[*_](?=\S)([^*_]+?)[*_](?![*\w])/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code class="icode">' + codes[i] + '</code>'; });
  }
  function md(src) {
    var out = [], para = [], list = null, quote = [], fence = null;
    function flushPara() { if (para.length) out.push('<p>' + para.map(inline).join(' ') + '</p>'); para = []; }
    function flushList() { if (list) out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'); list = null; }
    function flushQuote() { if (quote.length) out.push('<blockquote>' + md(quote.join('\n')) + '</blockquote>'); quote = []; }
    function flush() { flushPara(); flushList(); flushQuote(); }
    (src || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (l) {
      var m;
      if (fence) { if (/^\s*(```|~~~)/.test(l)) { out.push('<pre class="md-code"><code>' + esc(fence.join('\n')) + '</code></pre>'); fence = null; } else fence.push(l); return; }
      if (/^\s*(```|~~~)/.test(l)) { flush(); fence = []; return; }
      if ((m = l.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); return; }
      flushQuote();
      if (!l.trim()) { flushPara(); flushList(); return; }
      if ((m = l.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); var n = Math.min(m[1].length + 3, 6); out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); return; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); return; }
      if ((m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        flushPara();
        var tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        var item = m[2], box = item.match(/^\[([ xX])\]\s+(.*)$/);
        list.items.push(box ? '<li class="md-task"><span class="md-box' + (box[1] === ' ' ? '' : ' on') + '" aria-label="' + (box[1] === ' ' ? 'Not done' : 'Done') + '"></span>' + inline(box[2]) + '</li>' : '<li>' + inline(item) + '</li>');
        return;
      }
      /* A wrapped line under a list item belongs to that item */
      if (list && /^\s+\S/.test(l)) { var last = list.items.length - 1; list.items[last] = list.items[last].replace(/<\/li>$/, ' ' + inline(l.trim()) + '</li>'); return; }
      flushList(); para.push(l.trim());
    });
    if (fence) out.push('<pre class="md-code"><code>' + esc(fence.join('\n')) + '</code></pre>');
    flush();
    return out.join('');
  }

  var KINDS = {
    research: { label: 'Research', icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.5-4.5' },
    action: { label: 'Fuzz action', icon: 'M13 3L5 14h6l-1 7 8-11h-6z' },
    guidance: { label: 'Your guidance', icon: 'M4 5h16v11H9l-5 4z' },
    status: { label: 'Status change', icon: 'M5 21V4M5 4h11l-2 4 2 4H5' },
    sent: { label: 'Sent', icon: 'M22 2L11 13M22 2l-7 20-4-9-9-4z' },
    blocked: { label: 'Blocked', icon: 'M12 3L2 20h20zM12 10v4M12 17v.5' }
  };

  function logHTML(entries) {
    return '<ol class="log">' + entries.map(function (d) {
      var k = KINDS[d.kind] || KINDS.action;
      return '<li><span class="badge k-' + d.kind + '" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' + k.icon + '"/></svg></span>' +
        '<span class="log-body"><span class="log-meta"><span class="log-kind k-' + d.kind + '">' + k.label + '</span><span aria-hidden="true">&middot;</span><span>' + esc(/^\d{1,2}:\d{2}\s?[AP]M$/i.test(d.time) ? 'Today, ' + d.time : d.time) + '</span></span><span class="log-text">' + text(d.text) + '</span></span></li>';
    }).join('') + '</ol>';
  }

  function sourcesHTML(list) {
    return '<ul class="sources">' + list.map(function (s) {
      var href = s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" class="source">' : '<a href="#" data-noop class="source">';
      return '<li>' + href + '<span class="pill pill--muted">' + esc(s.type) + '</span><span class="source-title">' + esc(s.title) + '</span>' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg></a></li>';
    }).join('') + '</ul>';
  }

  /* Modal dialog built on <dialog> (focus trap and Escape come for free). */
  function dialog(html, o) {
    o = o || {};
    var d = document.createElement('dialog');
    d.className = 'dlg' + (o.cls ? ' ' + o.cls : '');
    d.innerHTML = html;
    document.body.appendChild(d);
    d.addEventListener('close', function () { d.remove(); if (o.onClose) o.onClose(); });
    /* A click on the backdrop closes it, but only when the press began there too: selecting text and
       letting go outside the box is not a click outside */
    var downOn = null;
    d.addEventListener('pointerdown', function (e) { downOn = e.target; });
    d.addEventListener('click', function (e) { if (e.target === d && downOn === d) d.close(); downOn = null; });
    d.showModal();
    return d;
  }

  window.UI = { esc: esc, text: text, md: md, pill: pill, logHTML: logHTML, sourcesHTML: sourcesHTML, dialog: dialog, KINDS: KINDS };
})();
