/* Small shared UI helpers. */
(function () {
  var toastTimer = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /* Status chips use a tone, never red. Tones map to theme tokens in app.css. */
  function pill(text, tone) { return '<span class="pill pill--' + (tone || 'muted') + '">' + esc(text) + '</span>'; }

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
        '<span class="log-body"><span class="log-meta"><span class="log-kind k-' + d.kind + '">' + k.label + '</span><span aria-hidden="true">&middot;</span><span>' + esc(d.time) + '</span></span><span class="log-text">' + esc(d.text) + '</span></span></li>';
    }).join('') + '</ol>';
  }

  function sourcesHTML(list) {
    return '<ul class="sources">' + list.map(function (s) {
      return '<li><a href="#" data-noop class="source"><span class="pill pill--muted">' + esc(s.type) + '</span><span class="source-title">' + esc(s.title) + '</span>' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg></a></li>';
    }).join('') + '</ul>';
  }

  /* ---------- Toasts (with Undo, so nothing feels permanent) ---------- */
  function toast(msg, o) {
    o = o || {};
    var box = document.getElementById('toasts');
    if (!box) return;
    box.innerHTML = '';
    var t = document.createElement('div');
    t.className = 'toast';
    var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (o.undo) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'toast-btn'; b.textContent = 'Undo';
      b.addEventListener('click', function () { box.innerHTML = ''; o.undo(); });
      t.appendChild(b);
    }
    if (o.action) {
      var a = document.createElement('button'); a.type = 'button'; a.className = 'toast-btn'; a.textContent = o.action.label;
      a.addEventListener('click', function () { box.innerHTML = ''; o.action.run(); });
      t.appendChild(a);
    }
    box.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (t.parentNode === box) box.innerHTML = ''; }, o.ms || 7000);
  }

  /* Run a change, keep a snapshot, and offer Undo. */
  function undoable(message, change, afterUndo) {
    var snap = Store.snapshot();
    change();
    toast(message, { undo: function () { Store.restore(snap); if (afterUndo) afterUndo(); } });
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

  window.UI = { esc: esc, pill: pill, logHTML: logHTML, sourcesHTML: sourcesHTML, toast: toast, undoable: undoable, dialog: dialog, KINDS: KINDS };
})();
