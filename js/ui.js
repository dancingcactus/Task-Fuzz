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
      return '<li><a href="#" data-noop class="source"><span class="pill pill--muted">' + esc(s.type) + '</span><span class="source-title">' + esc(s.title) + '</span>' +
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
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.showModal();
    return d;
  }

  window.UI = { esc: esc, text: text, pill: pill, logHTML: logHTML, sourcesHTML: sourcesHTML, dialog: dialog, KINDS: KINDS };
})();
