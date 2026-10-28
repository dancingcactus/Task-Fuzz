/* The artifact viewer (artifact.html): one file Fuzz wrote, opened in its own tab from the Artifacts tab or a
   task's Sources. ?id=<source id> reads it from the core (the token this browser keeps from `fuzz serve`);
   ?demo=<sample id> reads a demo file from assets/samples/.

   Markdown, Word (.docx), slides (.pptx), PDF, pictures, CSV tables, plain text and HTML each get a preview.
   Nothing in a file can run here: Markdown and Office files are drawn from escaped text (js/ui.js, js/office.js),
   PDFs use the browser's own viewer, and HTML shows in a sandboxed frame with scripts off. */
(function () {
  var esc = UI.esc;
  var LABEL = { markdown: 'Markdown', word: 'Word document', slides: 'Slides', pdf: 'PDF', image: 'Picture', html: 'Web page', table: 'Table', text: 'Text', other: 'File' };
  var ICON_BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  var ICON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  var main = document.getElementById('av'), bar = document.getElementById('av-bar');
  var q = new URLSearchParams(location.search), token = null;

  /* The app's theme, appearance and contrast, so the tab looks like the rest of Fuzz */
  try {
    var p = JSON.parse(localStorage.getItem('fuzz.prefs.v1') || 'null') || {};
    Themes.apply(p.theme || 'terracotta', p.mode || 'auto', p.contrast || 'standard', p.codeFont || 'jetbrains');
  } catch (e) { Themes.apply('terracotta', 'auto', 'standard', 'jetbrains'); }
  try { token = localStorage.getItem('fuzz.token'); } catch (e) { token = null; }

  function kindOf(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return { md: 'markdown', markdown: 'markdown', docx: 'word', pptx: 'slides', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
      html: 'html', htm: 'html', csv: 'table', tsv: 'table', txt: 'text', json: 'text', yaml: 'text', yml: 'text', py: 'text', js: 'text', ts: 'text', sql: 'text' }[ext] || 'other';
  }
  function sizeText(n) { if (n == null) return ''; if (n < 1024) return n + ' bytes'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  function agoText(t) {
    var m = (Date.now() - t) / 60000;
    if (m < 2) return 'just now';
    if (m < 60) return Math.round(m) + ' minutes ago';
    if (m < 1440) { var h = Math.round(m / 60); return h === 1 ? '1 hour ago' : h + ' hours ago'; }
    var d = Math.round(m / 1440); return d === 1 ? 'yesterday' : d + ' days ago';
  }

  /* ---------- Where the file comes from ---------- */
  function locate() {
    var demo = q.get('demo'), id = q.get('id');
    if (demo) {
      var s = (window.Samples || []).filter(function (x) { return x.id === demo; })[0];
      if (!s) return Promise.reject(new Error('There’s no demo file called ' + demo + '.'));
      return Promise.resolve({ name: s.name, kind: s.kind, size: s.size, updated: s.updated, task: s.taskTitle, url: s.path, get: function () { return fetch(s.path); } });
    }
    if (!id || !/^\d+$/.test(id)) return Promise.reject(new Error('Open a file from the Artifacts tab in Fuzz.'));
    if (!token) return Promise.reject(new Error('This browser isn’t connected to Fuzz. Open the link `fuzz serve` prints, then try again.'));
    var auth = { headers: { Authorization: 'Bearer ' + token } };
    return fetch('/artifacts/' + id, auth).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(r.status === 404 ? 'This file isn’t in your Fuzz folder any more.' : r.status === 401 ? 'Fuzz didn’t recognise this browser. Open the link `fuzz serve` prints, then try again.' : (j.error || 'Fuzz couldn’t open it.'));
        return { name: j.name, kind: j.kind || kindOf(j.name), size: j.size, updated: Date.parse(j.updated_at), task: j.task && j.task.title,
          url: '/files/' + id + '?token=' + encodeURIComponent(token), get: function () { return fetch('/files/' + id, auth); } };
      });
    });
  }
  function bytes(f) { return f.get().then(function (r) { if (!r.ok) throw new Error('Fuzz couldn’t read the file (' + r.status + ').'); return r.arrayBuffer(); }); }
  function text(f) { return bytes(f).then(function (b) { return new TextDecoder().decode(b); }); }

  /* ---------- The page ---------- */
  function header(f) {
    var meta = [LABEL[f.kind] || 'File', sizeText(f.size), f.updated ? 'Updated ' + agoText(f.updated) : ''].filter(Boolean).join(' · ');
    bar.innerHTML = '<div class="av-left"><a class="themebtn av-back" href="index.html#/artifacts">' + ICON_BACK + '<span class="lbl">Artifacts</span></a>' +
      '<div class="av-title"><h1>' + esc(f.name) + '</h1><p class="meta">' + esc(meta) + (f.task ? ' · For <span class="av-task">' + esc(f.task) + '</span>' : '') + '</p></div></div>' +
      '<div class="appbar-right"><a class="btn small av-dl" href="' + esc(f.url) + '" download="' + esc(f.name) + '">' + ICON_DOWN + '<span>Download</span></a></div>';
    document.title = f.name + ' · Fuzz';
  }
  function fail(msg, f) {
    main.innerHTML = '<div class="av-msg"><img src="assets/fuzz-mark.svg" alt="" width="56" height="56"><p>' + UI.text(msg) + '</p>' +
      (f ? '<a class="btn small" href="' + esc(f.url) + '" download="' + esc(f.name) + '">' + ICON_DOWN + '<span>Download it instead</span></a>' : '<a class="btn small" href="index.html#/artifacts">Go to Artifacts</a>') + '</div>';
  }

  var RENDER = {
    markdown: function (f) { return text(f).then(function (t) { main.innerHTML = '<article class="av-doc md">' + UI.md(t, { shift: 0 }) + '</article>'; }); },
    word: function (f) {
      if (!Office.supported()) return Promise.reject(new Error('This browser can’t open Word files. Download it to read it.'));
      return bytes(f).then(Office.docx).then(function (d) {
        main.innerHTML = '<p class="av-note">A preview. Open it in Word for the exact layout.</p><article class="av-doc av-word md">' + (d.html || '<p class="meta">This document is empty.</p>') + '</article>';
      });
    },
    slides: function (f) {
      if (!Office.supported()) return Promise.reject(new Error('This browser can’t open slides. Download them to look.'));
      return bytes(f).then(Office.pptx).then(function (d) {
        var n = d.slides.length, ratio = d.width + ' / ' + d.height;
        main.innerHTML = '<p class="av-note">' + n + (n === 1 ? ' slide' : ' slides') + '. A preview: fonts, charts and animations may look different in PowerPoint. ← and → move between slides.</p>' +
          '<ol class="av-slides">' + d.slides.map(function (s, i) {
            return '<li class="av-slide" id="slide-' + (i + 1) + '" tabindex="-1"><div class="slide-canvas" style="aspect-ratio:' + ratio + ';' + s.background + '" role="img" aria-label="Slide ' + (i + 1) + '"><div class="slide-inner">' + s.html + '</div></div>' +
              '<div class="slide-cap"><span>Slide ' + (i + 1) + (s.hidden ? ' · Hidden' : '') + '</span>' + (s.notes ? '<p class="slide-notes"><b>Notes</b> ' + esc(s.notes) + '</p>' : '') + '</div></li>';
          }).join('') + '</ol>';
        slideKeys();
      });
    },
    pdf: function (f) {
      main.innerHTML = '<iframe class="av-frame" src="' + esc(f.url) + '#view=FitH" title="' + esc(f.name) + '"></iframe>' +
        '<p class="av-note">Nothing showing? Some browsers won’t show a PDF inside a page. <a href="' + esc(f.url) + '" target="_blank" rel="noopener">Open the PDF on its own</a>.</p>';
      return Promise.resolve();
    },
    image: function (f) { main.innerHTML = '<figure class="av-pic"><img src="' + esc(f.url) + '" alt="' + esc(f.name) + '"></figure>'; return Promise.resolve(); },
    /* Scripts, forms and links to other pages are off: sandbox="" with nothing allowed */
    html: function (f) {
      return text(f).then(function (t) {
        main.innerHTML = '<p class="av-note">Scripts are off in the preview.</p><iframe class="av-frame av-html" sandbox="" title="' + esc(f.name) + '"></iframe>';
        main.querySelector('iframe').srcdoc = t;
      });
    },
    table: function (f) {
      return text(f).then(function (t) {
        var rows = csv(t, /\.tsv$/i.test(f.name) ? '\t' : ','), head = rows.shift() || [];
        main.innerHTML = '<p class="av-note">' + rows.length + (rows.length === 1 ? ' row' : ' rows') + '</p><div class="av-doc av-table tablewrap"><table><thead><tr>' + head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + head.map(function (h, i) { return '<td>' + esc(r[i] || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      });
    },
    text: function (f) {
      return text(f).then(function (t) {
        if (/\.json$/i.test(f.name)) { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* show it as written */ } }
        main.innerHTML = '<pre class="av-doc md-code av-text"><code>' + esc(t) + '</code></pre>';
      });
    },
    other: function (f) { fail('Fuzz can’t preview this kind of file yet.', f); return Promise.resolve(); }
  };

  /* Quoted fields, doubled quotes and line breaks inside quotes, the way spreadsheets write CSV */
  function csv(t, sep) {
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (quoted) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
      if (ch === '"') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }

  /* ← and → (or PageUp and PageDown) go to the slide before or after the one at the top */
  function slideKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var dir = e.key === 'ArrowRight' || e.key === 'PageDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 0;
      if (!dir) return;
      var list = Array.prototype.slice.call(document.querySelectorAll('.av-slide')), top = bar.getBoundingClientRect().bottom + 8, cur = 0;
      list.forEach(function (s, i) { if (s.getBoundingClientRect().top <= top + 4) cur = i; });
      var next = list[Math.max(0, Math.min(list.length - 1, cur + dir))];
      if (next) { e.preventDefault(); next.focus({ preventScroll: true }); next.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
    });
  }

  window.addEventListener('pagehide', function () { if (window.Office) Office.release(); });

  locate().then(function (f) {
    header(f);
    main.className = 'av av--' + f.kind;
    return (RENDER[f.kind] || RENDER.other)(f).catch(function (e) { console.error('[fuzz artifact]', e); fail(e.message || 'Fuzz couldn’t open it.', f); });
  }).catch(function (e) {
    bar.innerHTML = '<div class="av-left"><a class="themebtn av-back" href="index.html#/artifacts">' + ICON_BACK + '<span class="lbl">Artifacts</span></a></div>';
    fail(e.message);
  });
})();
