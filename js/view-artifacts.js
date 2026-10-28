/* Artifacts: every file Fuzz has written in your Fuzz folder, newest first, with the task it's for. Each one
   opens in the viewer (artifact.html) in this tab, which previews Markdown, Word, PDF and slides. Live mode lists the real
   folder (GET /artifacts) and updates when Fuzz writes; the demo lists the samples in js/samples.js. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root = null, unsub = null, items = null, folder, filter = 'all', failed = null, timer = 0;

  var FILTERS = [
    ['all', 'All', null],
    ['docs', 'Documents', ['markdown', 'word', 'text', 'html']],
    ['slides', 'Slides', ['slides']],
    ['pdf', 'PDFs', ['pdf']],
    ['other', 'Other', ['table', 'image', 'other']]
  ];
  var BADGE = { markdown: 'MD', word: 'DOC', slides: 'PPT', pdf: 'PDF', table: 'CSV', image: 'IMG', html: 'WEB', text: 'TXT', other: 'FILE' };
  var KIND = { markdown: 'Markdown', word: 'Word document', slides: 'Slides', pdf: 'PDF', table: 'Table', image: 'Picture', html: 'Web page', text: 'Text', other: 'File' };
  var ICON_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';

  function sizeText(n) { if (n == null) return ''; if (n < 1024) return n + ' bytes'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  function agoText(t) {
    if (!t) return '';
    var m = (Date.now() - t) / 60000;
    if (m < 2) return 'Just now';
    if (m < 60) return Math.round(m) + ' min ago';
    if (m < 1440) { var h = Math.round(m / 60); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var d = Math.round(m / 1440); return d === 1 ? 'Yesterday' : d + ' days ago';
  }

  function load() {
    if (!Live.on()) {
      folder = 'demo';
      items = Samples.map(function (s) {
        var it = Store.item(s.task);
        return { key: s.id, name: s.name, kind: s.kind, size: s.size, updated: s.updated, task: it ? it.title : s.taskTitle, url: s.url };
      });
      return paint();
    }
    Live.artifacts().then(function (r) {
      failed = null; folder = r.folder;
      items = r.artifacts.map(function (a) {
        return { key: String(a.source_id), name: a.name, kind: a.kind, size: a.size, updated: Date.parse(a.updated_at), task: a.task.title, url: 'artifact.html?id=' + a.source_id };
      });
    }).catch(function (e) { failed = e.message; }).then(function () { if (root) paint(); });
  }
  /* Fuzz writes files mid-run, so any event from the core may mean a new one; a burst refreshes once */
  function soon() { clearTimeout(timer); timer = setTimeout(load, 600); }

  function rowHTML(a) {
    return '<li><a class="lrow arow" href="' + esc(a.url) + '" aria-label="' + esc(a.name + ', ' + KIND[a.kind]) + '">' +
      '<span class="afile afile--' + esc(a.kind) + '" aria-hidden="true">' + BADGE[a.kind] + '</span>' +
      '<span class="lrow-main"><span class="rt">' + esc(a.name) + '</span><span class="rs">For ' + esc(a.task || 'a task') + '</span></span>' +
      '<span class="lrow-side"><span class="lrow-sub">' + esc(agoText(a.updated)) + '</span><span class="lrow-sub">' + esc(sizeText(a.size)) + '</span></span>' +
      '<span class="arow-go">' + ICON_OPEN + '</span></a></li>';
  }

  function paint() {
    var head = '<div class="tasks-head"><h1>Artifacts</h1><p class="meta">What Fuzz has written for your tasks: documents, decks, checklists.</p></div>';
    if (failed) { root.innerHTML = head + '<p class="lempty">Fuzz couldn’t list your files: ' + esc(failed) + '</p>'; return; }
    if (!items) { root.innerHTML = head + '<p class="lempty">Looking in your Fuzz folder…</p>'; return; }
    if (folder === null) {
      root.innerHTML = head + '<div class="empty aempty"><p>Fuzz has nowhere to write files yet. Pick a folder and he’ll keep each task’s documents there.</p><button type="button" class="btn small" data-setup="1">Set up Fuzz</button></div>';
      return;
    }
    var f = FILTERS.filter(function (x) { return x[0] === filter; })[0] || FILTERS[0];
    var shown = items.filter(function (a) { return !f[2] || f[2].indexOf(a.kind) > -1; });
    var chips = items.length ? '<div class="segrow afilters" role="group" aria-label="Show">' + FILTERS.map(function (x) {
      var n = items.filter(function (a) { return !x[2] || x[2].indexOf(a.kind) > -1; }).length;
      return n || x[0] === 'all' ? '<button type="button" class="seg" data-filter="' + x[0] + '" aria-pressed="' + (x[0] === filter) + '">' + x[1] + ' <span class="lcount">' + n + '</span></button>' : '';
    }).join('') + '</div>' : '';
    var body = !items.length
      ? '<p class="lempty">Nothing yet. When Fuzz writes a document, a deck or a checklist for a task, it shows up here' + (folder && folder !== 'demo' ? ', and in ' + esc(folder) : '') + '.</p>'
      : shown.length ? '<ul class="lrows">' + shown.map(rowHTML).join('') + '</ul>' : '<p class="lempty">None of these yet.</p>';
    root.innerHTML = head + chips + body;
  }

  V.mount = function (el) {
    root = document.createElement('section'); root.className = 'lineup artifacts'; el.appendChild(root);
    items = null; failed = null;
    root.addEventListener('click', onClick);
    paint(); load();
    unsub = Live.on() ? Live.onEvent(soon) : Store.on(function (e) { if (e.type === 'reset') load(); });
  };
  V.unmount = function () {
    if (unsub) unsub(); unsub = null; clearTimeout(timer);
    if (root) root.removeEventListener('click', onClick);
    root = null;
  };
  function onClick(e) {
    var b = e.target.closest('[data-filter]');
    if (b) { filter = b.dataset.filter; paint(); var again = root.querySelector('[data-filter="' + filter + '"]'); if (again) again.focus(); return; }
    if (e.target.closest('[data-setup]')) Setup.open(2);   /* the Folder step */
  }

  window.ArtifactsView = V;
})();
