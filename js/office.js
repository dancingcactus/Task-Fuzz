/* Previews of Word (.docx) and PowerPoint (.pptx) files, drawn as HTML with no library (js/zip.js opens them).
   A preview, not a converter: headings, paragraphs, bold and italic, lists, tables, links and pictures for
   Word; each slide's boxes, text, pictures, tables, fills and speaker notes for PowerPoint, placed where the
   file puts them. Fonts, effects, charts and SmartArt aren't drawn. Every bit of text is escaped, and only
   http(s) links and pictures from inside the file become markup, so a file can't run anything. */
(function () {
  var esc = UI.esc;
  var EMU_PT = 12700;
  var IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };

  /* ---------- XML helpers: by local name, so the w:, a:, p: and r: prefixes don't matter ---------- */
  function kids(el, name) { var out = []; if (!el) return out; for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c); return out; }
  function kid(el, name) { if (!el) return null; for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c; return null; }
  function path(el) { for (var i = 1; i < arguments.length && el; i++) el = kid(el, arguments[i]); return el || null; }
  function find(el, name) { return el ? Array.prototype.slice.call(el.getElementsByTagNameNS('*', name)) : []; }
  function at(el, name) {
    if (!el || !el.attributes) return null;
    for (var i = 0; i < el.attributes.length; i++) { var a = el.attributes[i]; if (a.localName === name) return a.value; }
    return null;
  }
  /* A relationship id (r:id), which some elements carry beside an id of their own (<p:sldId id="256" r:id="rId2">) */
  function rid(el) {
    if (!el || !el.attributes) return null;
    for (var i = 0; i < el.attributes.length; i++) { var x = el.attributes[i]; if (x.localName === 'id' && /relationships/.test(x.namespaceURI || '')) return x.value; }
    return null;
  }
  function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
  /* <w:b/> is on, <w:b w:val="0"/> is off */
  function flag(pr, name) { var e = kid(pr, name); if (!e) return false; var v = at(e, 'val'); return v !== '0' && v !== 'false' && v !== 'none'; }

  function dir(p) { return p.slice(0, p.lastIndexOf('/') + 1); }
  function resolve(base, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = (dir(base) + target).split('/'), out = [];
    parts.forEach(function (s) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
    return out.join('/');
  }
  /* A part's relationships: id -> { path, type, external } */
  function rels(zip, part) {
    return zip.xml(dir(part) + '_rels/' + part.slice(part.lastIndexOf('/') + 1) + '.rels').then(function (x) {
      var map = {};
      find(x, 'Relationship').forEach(function (r) {
        var ext = at(r, 'TargetMode') === 'External', t = at(r, 'Target') || '';
        map[at(r, 'Id')] = { path: ext ? t : resolve(part, t), type: (at(r, 'Type') || '').split('/').pop(), external: ext };
      });
      return map;
    });
  }
  function relOfType(map, type) { for (var k in map) if (map[k].type === type) return map[k]; return null; }
  function webLink(rel) { return rel && rel.external && /^https?:\/\//i.test(rel.path) ? rel.path : null; }

  /* Pictures become blob: URLs; the viewer frees them when it closes. Formats a browser can't draw (EMF, WMF) are skipped. */
  var urls = [];
  function picture(zip, rel) {
    if (!rel || rel.external) return Promise.resolve(null);
    var type = IMG[(rel.path.split('.').pop() || '').toLowerCase()];
    if (!type) return Promise.resolve(null);
    return zip.bytes(rel.path).then(function (b) {
      if (!b) return null;
      var u = URL.createObjectURL(new Blob([b], { type: type })); urls.push(u); return u;
    });
  }
  /* Fetch every picture a part refers to first, so the drawing below can stay synchronous */
  function pictures(zip, map, ids) {
    var out = {};
    return Promise.all(ids.filter(function (id, i) { return id && ids.indexOf(id) === i; }).map(function (id) {
      return picture(zip, map[id]).then(function (u) { out[id] = u; });
    })).then(function () { return out; });
  }
  function blipIds(el) { return find(el, 'blip').map(function (b) { return at(b, 'embed'); }).concat(find(el, 'imagedata').map(function (b) { return rid(b); })); }

  /* ---------- Word ---------- */
  function docx(buf) {
    var zip = Zip.open(buf), part = 'word/document.xml';
    return Promise.all([zip.xml(part), zip.xml('word/styles.xml'), zip.xml('word/numbering.xml'), rels(zip, part)]).then(function (r) {
      var doc = r[0], styles = r[1], numbering = r[2], links = r[3];
      if (!doc) throw new Error('This .docx has no document in it');
      return pictures(zip, links, blipIds(doc)).then(function (pics) { return { html: wordBody(doc, styleMap(styles), listFormats(numbering), links, pics) }; });
    });
  }
  function styleMap(x) {
    var map = {};
    find(x, 'style').forEach(function (s) {
      var np = path(s, 'pPr', 'numPr');
      map[at(s, 'styleId')] = { name: (at(kid(s, 'name'), 'val') || '').toLowerCase(), basedOn: at(kid(s, 'basedOn'), 'val'), numId: np ? at(kid(np, 'numId'), 'val') : null, ilvl: np ? at(kid(np, 'ilvl'), 'val') : null };
    });
    return map;
  }
  /* numId -> level -> 'ul' | 'ol' */
  function listFormats(x) {
    var abs = {}, out = {};
    find(x, 'abstractNum').forEach(function (a) {
      var lv = {}; kids(a, 'lvl').forEach(function (l) { lv[at(l, 'ilvl')] = at(kid(l, 'numFmt'), 'val') === 'bullet' ? 'ul' : 'ol'; });
      abs[at(a, 'abstractNumId')] = lv;
    });
    find(x, 'num').forEach(function (n) { out[at(n, 'numId')] = abs[at(kid(n, 'abstractNumId'), 'val')] || {}; });
    return out;
  }
  function wordBody(doc, styles, lists, links, pics) {
    function style(id) { var seen = 0, s = styles[id]; while (s && seen++ < 10) { if (s.numId || /^heading \d$|^title$|^subtitle$/.test(s.name)) return s; s = styles[s.basedOn]; } return styles[id] || null; }
    function runs(el, out) {
      kids(el).forEach(function (c) {
        var n = c.localName;
        if (n === 'r') out.push(run(c));
        else if (n === 'hyperlink') { var href = webLink(links[rid(c)]), inner = []; runs(c, inner); out.push(href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + inner.join('') + '</a>' : inner.join('')); }
        else if (n === 'ins' || n === 'smartTag' || n === 'fldSimple' || n === 'customXml' || n === 'sdt' || n === 'sdtContent') runs(c, out);
      });
      return out;
    }
    function run(r) {
      var pr = kid(r, 'rPr'), s = '';
      kids(r).forEach(function (c) {
        var n = c.localName;
        if (n === 't') s += esc(c.textContent);
        else if (n === 'tab') s += ' ';
        else if (n === 'br' || n === 'cr') s += '<br>';
        else if (n === 'drawing' || n === 'pict') blipIds(c).forEach(function (id) { if (pics[id]) s += '<img src="' + pics[id] + '" alt="">'; });
      });
      if (!s) return '';
      if (flag(pr, 'b')) s = '<strong>' + s + '</strong>';
      if (flag(pr, 'i')) s = '<em>' + s + '</em>';
      if (flag(pr, 'u')) s = '<u>' + s + '</u>';
      if (flag(pr, 'strike') || flag(pr, 'dstrike')) s = '<del>' + s + '</del>';
      var va = at(kid(pr, 'vertAlign'), 'val');
      if (va === 'superscript') s = '<sup>' + s + '</sup>'; else if (va === 'subscript') s = '<sub>' + s + '</sub>';
      return s;
    }
    function blocks(el) {
      var out = [], stack = [];
      function closeTo(lvl) { while (stack.length && stack[stack.length - 1].lvl > lvl) out.push('</li></' + stack.pop().tag + '>'); }
      kids(el).forEach(function (c) {
        if (c.localName === 'sdt') { closeTo(-1); out.push(blocks(kid(c, 'sdtContent'))); return; }
        if (c.localName === 'tbl') { closeTo(-1); out.push(table(c)); return; }
        if (c.localName !== 'p') return;
        var pr = kid(c, 'pPr'), sid = at(kid(pr, 'pStyle'), 'val'), st = style(sid), np = kid(pr, 'numPr');
        var numId = np ? at(kid(np, 'numId'), 'val') : st && st.numId, ilvl = num(np ? at(kid(np, 'ilvl'), 'val') : st && st.ilvl, 0);
        var body = runs(c, []).join(''), jc = at(kid(pr, 'jc'), 'val');
        var align = jc === 'center' ? ' style="text-align:center"' : jc === 'right' || jc === 'end' ? ' style="text-align:right"' : jc === 'both' ? ' style="text-align:justify"' : '';
        if (numId && numId !== '0') {
          var tag = (lists[numId] || {})[ilvl] || 'ul', top = stack[stack.length - 1];
          closeTo(ilvl); top = stack[stack.length - 1];
          if (top && top.lvl === ilvl && top.tag !== tag) { out.push('</li></' + stack.pop().tag + '>'); top = null; }
          if (top && top.lvl === ilvl) out.push('</li>');
          else { out.push('<' + tag + '>'); stack.push({ tag: tag, lvl: ilvl }); }
          out.push('<li' + align + '>' + body);
          return;
        }
        closeTo(-1);
        if (!body) return;
        var h = st && /^heading (\d)$/.exec(st.name);
        if (st && st.name === 'title') out.push('<h1' + align + '>' + body + '</h1>');
        else if (st && st.name === 'subtitle') out.push('<p class="subtitle"' + align + '>' + body + '</p>');
        else if (h) { var n = Math.min(+h[1] + 1, 6); out.push('<h' + n + align + '>' + body + '</h' + n + '>'); }
        else out.push('<p' + align + '>' + body + '</p>');
      });
      closeTo(-1);
      return out.join('');
    }
    function table(t) {
      return '<div class="tablewrap"><table>' + kids(t, 'tr').map(function (tr) {
        return '<tr>' + kids(tr, 'tc').map(function (tc) {
          var pr = kid(tc, 'tcPr'), vm = kid(pr, 'vMerge');
          if (vm && at(vm, 'val') !== 'restart') return '';   /* merged into the cell above */
          var span = num(at(kid(pr, 'gridSpan'), 'val'), 1);
          return '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + '>' + blocks(tc) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</table></div>';
    }
    return blocks(path(doc.documentElement, 'body'));
  }

  /* ---------- PowerPoint ---------- */
  var SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
  function pptx(buf) {
    var zip = Zip.open(buf), part = 'ppt/presentation.xml';
    return Promise.all([zip.xml(part), rels(zip, part)]).then(function (r) {
      var pres = r[0], prels = r[1];
      if (!pres) throw new Error('This .pptx has no presentation in it');
      var sz = find(pres, 'sldSz')[0], W = num(at(sz, 'cx'), 12192000), H = num(at(sz, 'cy'), 6858000);
      var paths = find(pres, 'sldId').map(function (s) { var rel = prels[rid(s)]; return rel && rel.path; }).filter(Boolean);
      var cache = {};
      function part2(p) { if (!cache[p]) cache[p] = Promise.all([zip.xml(p), rels(zip, p)]).then(function (x) { return { xml: x[0], rels: x[1], path: p }; }); return cache[p]; }
      return Promise.all(paths.map(function (p) { return slide(zip, part2, p, W, H); })).then(function (slides) { return { slides: slides, width: W, height: H }; });
    });
  }
  function slide(zip, load, p, W, H) {
    var s, layout, master, theme, notes;
    return load(p).then(function (x) {
      s = x; var l = relOfType(s.rels, 'slideLayout');
      return l ? load(l.path) : { xml: null, rels: {} };
    }).then(function (x) {
      layout = x; var m = relOfType(layout.rels, 'slideMaster');
      return m ? load(m.path) : { xml: null, rels: {} };
    }).then(function (x) {
      master = x; var t = relOfType(master.rels, 'theme'), n = relOfType(s.rels, 'notesSlide');
      return Promise.all([t ? zip.xml(t.path) : null, n ? zip.xml(n.path) : null]);
    }).then(function (x) {
      theme = x[0]; notes = x[1];
      var ids = blipIds(s.xml), bgOwner = [s, layout, master].filter(function (o) { return o.xml && path(o.xml.documentElement, 'cSld', 'bg'); })[0];
      return Promise.all([pictures(zip, s.rels, ids), bgOwner ? pictures(zip, bgOwner.rels, blipIds(path(bgOwner.xml.documentElement, 'cSld', 'bg'))) : {}]);
    }).then(function (pics) {
      return drawSlide({ slide: s, layout: layout, master: master, colors: schemeColors(theme), pics: pics[0], bgPics: pics[1], W: W, H: H, notes: notes });
    });
  }
  function schemeColors(theme) {
    var out = {}, cs = find(theme, 'clrScheme')[0];
    kids(cs).forEach(function (c) { var v = kid(c, 'srgbClr'), sys = kid(c, 'sysClr'); out[c.localName] = v ? '#' + at(v, 'val') : sys ? '#' + (at(sys, 'lastClr') || '000000') : null; });
    return out;
  }
  function drawSlide(c) {
    var W = c.W, Wpt = W / EMU_PT, root = c.slide.xml.documentElement;
    function color(fill) {
      if (!fill) return null;
      var v = kid(fill, 'srgbClr'); if (v) return '#' + at(v, 'val');
      v = kid(fill, 'schemeClr'); if (v) { var k = at(v, 'val'); return c.colors[SCHEME_ALIAS[k] || k] || null; }
      v = kid(fill, 'sysClr'); if (v) return '#' + (at(v, 'lastClr') || '000000');
      v = kid(fill, 'prstClr'); if (v) return at(v, 'val');
      return null;
    }
    /* Placeholders inherit position and text style from the layout, then the master, by idx or type */
    function phOf(sp) { var ph = path(sp, 'nvSpPr', 'nvPr', 'ph') || path(sp, 'nvPicPr', 'nvPr', 'ph') || path(sp, 'nvGraphicFramePr', 'nvPr', 'ph'); return ph ? { type: at(ph, 'type') || 'body', idx: at(ph, 'idx') } : null; }
    function inherited(ph, from) {
      if (!ph || !from || !from.xml) return null;
      var shapes = find(path(from.xml.documentElement, 'cSld', 'spTree'), 'sp'), hit = null;
      shapes.forEach(function (sp) { var o = phOf(sp); if (!o || hit) return; if (ph.idx != null && o.idx === ph.idx) hit = sp; });
      if (!hit) shapes.forEach(function (sp) { var o = phOf(sp); if (!o || hit) return; if (o.type === ph.type || (ph.type === 'ctrTitle' && o.type === 'title') || (ph.type === 'subTitle' && o.type === 'body')) hit = sp; });
      return hit;
    }
    function chain(sp) { var ph = phOf(sp), l = inherited(ph, c.layout), m = inherited(ph, c.master) || (l && inherited(phOf(l), c.master)); return [sp, l, m].filter(Boolean); }
    function xfrmOf(sp) { var list = chain(sp); for (var i = 0; i < list.length; i++) { var x = path(list[i], 'spPr', 'xfrm'); if (x && kid(x, 'off')) return x; } return null; }
    function txStyle(ph) {
      var ts = path(c.master.xml && c.master.xml.documentElement, 'txStyles');
      if (!ph) return kid(ts, 'otherStyle');
      return kid(ts, ph.type === 'title' || ph.type === 'ctrTitle' ? 'titleStyle' : ph.type === 'body' || ph.type === 'subTitle' || ph.type === 'obj' ? 'bodyStyle' : 'otherStyle');
    }
    /* The level's paragraph properties, nearest first: the shape's own list style, its layout and master placeholders, then the master's text styles */
    function lvlProps(shapes, ph, lvl) {
      var name = 'lvl' + (lvl + 1) + 'pPr', out = [];
      shapes.forEach(function (sp) { var e = kid(path(sp, 'txBody', 'lstStyle'), name); if (e) out.push(e); });
      var e = kid(txStyle(ph), name); if (e) out.push(e);
      return out;
    }
    function first(list, fn) { for (var i = 0; i < list.length; i++) { var v = fn(list[i]); if (v != null) return v; } return null; }

    function text(sp, tx) {
      var shapes = chain(sp), ph = phOf(sp), scale = 1;
      var fit = first(shapes, function (s) { return path(s, 'txBody', 'bodyPr', 'normAutofit'); });
      if (fit && at(fit, 'fontScale')) scale = num(at(fit, 'fontScale'), 100000) / 100000;
      var listed = !ph || ph.type === 'title' || ph.type === 'ctrTitle' || ph.type === 'subTitle' ? false : true;
      return kids(tx, 'p').map(function (p) {
        var pPr = kid(p, 'pPr'), lvl = num(at(pPr, 'lvl'), 0), props = [pPr].concat(lvlProps(shapes, ph, lvl)).filter(Boolean);
        var algn = first(props, function (e) { return at(e, 'algn'); });
        var bullet = !kid(pPr, 'buNone') && first(props, function (e) { return kid(e, 'buNone') ? 'none' : kid(e, 'buAutoNum') ? 'num' : kid(e, 'buChar') ? at(kid(e, 'buChar'), 'char') : null; });
        if (!listed && bullet && !kid(pPr, 'buChar') && !kid(pPr, 'buAutoNum')) bullet = null;
        var defSz = first(props, function (e) { return at(kid(e, 'defRPr'), 'sz'); });
        var defColor = first(props, function (e) { return color(path(e, 'defRPr', 'solidFill')); });
        var defB = first(props, function (e) { return at(kid(e, 'defRPr'), 'b'); });
        var sizes = [], body = kids(p).map(function (r) {
          if (r.localName === 'br') return '<br>';
          if (r.localName !== 'r' && r.localName !== 'fld') return '';
          var pr = kid(r, 'rPr'), t = esc(path(r, 't') ? path(r, 't').textContent : '');
          if (!t) return '';
          var sz = num(at(pr, 'sz') || defSz, ph && (ph.type === 'title' || ph.type === 'ctrTitle') ? 4400 : 1800) / 100 * scale;
          sizes.push(sz);
          var css = 'font-size:' + (sz / Wpt * 100).toFixed(3) + 'cqw', col = color(kid(pr, 'solidFill')) || defColor;
          if (col) css += ';color:' + col;
          if ((at(pr, 'b') || defB) === '1') css += ';font-weight:700';
          if (at(pr, 'i') === '1') css += ';font-style:italic';
          if (at(pr, 'u') && at(pr, 'u') !== 'none') css += ';text-decoration:underline';
          var link = kid(pr, 'hlinkClick'), href = link && webLink(c.slide.rels[rid(link)]);
          var span = '<span style="' + css + '">' + t + '</span>';
          return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + span + '</a>' : span;
        }).join('');
        var end = num(at(kid(p, 'endParaRPr'), 'sz') || defSz, 1800) / 100 * scale;
        var css = 'font-size:' + ((sizes.length ? Math.max.apply(null, sizes) : end) / Wpt * 100).toFixed(3) + 'cqw';
        if (algn === 'ctr') css += ';text-align:center'; else if (algn === 'r') css += ';text-align:right'; else if (algn === 'just') css += ';text-align:justify';
        if (lvl) css += ';margin-left:' + (lvl * 4) + '%';
        var mark = body && bullet && bullet !== 'none' ? '<span class="bu" aria-hidden="true">' + (bullet === 'num' ? '•' : esc(bullet)) + '</span>' : '';
        return '<p style="' + css + '">' + mark + (body || '&nbsp;') + '</p>';
      }).join('');
    }
    function box(x, y, w, h) {
      var pc = function (v, of) { return (v / of * 100).toFixed(3) + '%'; };
      return 'left:' + pc(x, W) + ';top:' + pc(y, c.H) + ';width:' + pc(w, W) + ';height:' + pc(h, c.H);
    }
    /* A group maps its children's coordinates onto its own box */
    function shapes(tree, map) {
      return kids(tree).map(function (el) {
        var n = el.localName;
        if (n === 'grpSp') {
          var gx = path(el, 'grpSpPr', 'xfrm'); if (!gx) return shapes(el, map);
          var off = kid(gx, 'off'), ext = kid(gx, 'ext'), co = kid(gx, 'chOff'), ce = kid(gx, 'chExt');
          var ox = num(at(off, 'x'), 0), oy = num(at(off, 'y'), 0), sx = num(at(ext, 'cx'), 1) / (num(at(ce, 'cx'), 0) || num(at(ext, 'cx'), 1)), sy = num(at(ext, 'cy'), 1) / (num(at(ce, 'cy'), 0) || num(at(ext, 'cy'), 1));
          var cx0 = num(at(co, 'x'), 0), cy0 = num(at(co, 'y'), 0);
          return shapes(el, function (x, y, w, h) { return map(ox + (x - cx0) * sx, oy + (y - cy0) * sy, w * sx, h * sy); });
        }
        if (n !== 'sp' && n !== 'pic' && n !== 'graphicFrame' && n !== 'cxnSp') return '';
        var xf = n === 'graphicFrame' ? kid(el, 'xfrm') : xfrmOf(el);
        if (!xf) return '';
        var o = kid(xf, 'off'), e = kid(xf, 'ext'), r = map(num(at(o, 'x'), 0), num(at(o, 'y'), 0), num(at(e, 'cx'), 0), num(at(e, 'cy'), 0));
        var spPr = kid(el, 'spPr'), css = box(r[0], r[1], r[2], r[3]), geom = at(kid(spPr, 'prstGeom'), 'prst');
        var rot = num(at(xf, 'rot'), 0); if (rot) css += ';transform:rotate(' + (rot / 60000) + 'deg)';
        if (n === 'cxnSp') { var lc = color(path(spPr, 'ln', 'solidFill')) || c.colors.tx1 || c.colors.dk1 || '#888'; return '<div class="shape line" style="' + css + ';border-top:1px solid ' + lc + '"></div>'; }
        if (n === 'pic') { var id = at(find(el, 'blip')[0], 'embed'); return c.pics[id] ? '<img class="shape" style="' + css + '" src="' + c.pics[id] + '" alt="">' : ''; }
        if (n === 'graphicFrame') { var tbl = find(el, 'tbl')[0]; return tbl ? '<div class="shape" style="' + css + '">' + slideTable(tbl) + '</div>' : '<div class="shape unsupported" style="' + css + '"><span>Chart or diagram (not shown in the preview)</span></div>'; }
        var fill = kid(spPr, 'noFill') ? null : color(kid(spPr, 'solidFill')), ln = path(spPr, 'ln');
        if (fill) css += ';background:' + fill;
        if (ln && !kid(ln, 'noFill') && color(kid(ln, 'solidFill'))) css += ';border:' + Math.max(1, num(at(ln, 'w'), 12700) / W * 1000).toFixed(1) + 'px solid ' + color(kid(ln, 'solidFill'));
        if (geom === 'ellipse') css += ';border-radius:50%'; else if (geom === 'roundRect') css += ';border-radius:6%';
        var tx = kid(el, 'txBody'), body = tx ? text(el, tx) : '';
        if (!body && !fill) return '';
        var bp = first(chain(el), function (s) { return path(s, 'txBody', 'bodyPr'); });
        var anchor = first(chain(el), function (s) { return at(path(s, 'txBody', 'bodyPr'), 'anchor'); }) || 't';
        var ins = function (k, d) { return (num(at(bp, k), d) / W * 100).toFixed(3) + '%'; };
        css += ';justify-content:' + (anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start');
        css += ';padding:' + ins('tIns', 45720) + ' ' + ins('rIns', 91440) + ' ' + ins('bIns', 45720) + ' ' + ins('lIns', 91440);
        var defColor = c.colors.dk1; if (defColor) css += ';color:' + defColor;
        return '<div class="shape text" style="' + css + '">' + body + '</div>';
      }).join('');
    }
    function slideTable(tbl) {
      var cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map(function (g) { return num(at(g, 'w'), 0); }), total = cols.reduce(function (a, b) { return a + b; }, 0) || 1;
      return '<table><colgroup>' + cols.map(function (w) { return '<col style="width:' + (w / total * 100).toFixed(2) + '%">'; }).join('') + '</colgroup>' + kids(tbl, 'tr').map(function (tr, i) {
        return '<tr>' + kids(tr, 'tc').map(function (tc) {
          if (at(tc, 'hMerge') === '1' || at(tc, 'vMerge') === '1') return '';
          var span = num(at(tc, 'gridSpan'), 1), tag = i === 0 ? 'th' : 'td', fill = color(path(tc, 'tcPr', 'solidFill'));
          return '<' + tag + (span > 1 ? ' colspan="' + span + '"' : '') + (fill ? ' style="background:' + fill + '"' : '') + '>' + text(tc, kid(tc, 'txBody')) + '</' + tag + '>';
        }).join('') + '</tr>';
      }).join('') + '</table>';
    }
    function background() {
      var owners = [c.slide, c.layout, c.master];
      for (var i = 0; i < owners.length; i++) {
        var bg = owners[i].xml && path(owners[i].xml.documentElement, 'cSld', 'bg'); if (!bg) continue;
        var pr = kid(bg, 'bgPr'), col = color(kid(pr, 'solidFill')), blip = find(bg, 'blip')[0];
        if (blip && c.bgPics[at(blip, 'embed')]) return 'background:#fff url(' + c.bgPics[at(blip, 'embed')] + ') center/cover';
        if (col) return 'background:' + col;
        var ref = kid(bg, 'bgRef'); if (ref && color(ref)) return 'background:' + color(ref);
        return 'background:#fff';
      }
      return 'background:#fff';
    }
    var notes = '';
    if (c.notes) {
      find(c.notes, 'sp').forEach(function (sp) { var ph = phOf(sp); if (ph && ph.type === 'body') notes = kids(kid(sp, 'txBody'), 'p').map(function (p) { return find(p, 't').map(function (t) { return t.textContent; }).join(''); }).filter(Boolean).join('\n'); });
    }
    var tree = path(root, 'cSld', 'spTree');
    return { html: shapes(tree, function (x, y, w, h) { return [x, y, w, h]; }), background: background(), notes: notes, hidden: at(root, 'show') === '0' };
  }

  window.Office = {
    docx: docx, pptx: pptx,
    supported: function () { return window.Zip && Zip.supported; },
    release: function () { urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = []; }
  };
})();
