/* The Warm Theme System.
   - FOUNDATION: warm surfaces, text and status colours shared by every theme, in standard and high contrast.
   - THEMES: each theme only supplies three colours (accent, on-accent, link) for light, dark, and the two high-contrast variants.
   - CODE: syntax colours for the code preview. They stay the same in every theme; the accent marks the highlighted line and Copy button.
   Values come from the Warm Theme System artifact. */
(function () {
  var FOUNDATION = {
    std: {
      light: { bg: '#FBF3E8', surface: '#FFFBF4', field: '#F6EBDB', ink: '#3A2A20', muted: '#7A6454', line: '#E8D9C5', chip: '#F0E1CC', done: '#3E7B4F', wait: '#A86B12', blocked: '#B23A32' },
      dark: { bg: '#1E1612', surface: '#2A201A', field: '#352920', ink: '#F4E8DB', muted: '#C2AB98', line: '#43352B', chip: '#3B2D23', done: '#8CC59A', wait: '#E8B65E', blocked: '#F28C80' }
    },
    hc: {
      light: { bg: '#FFF8EE', surface: '#FFFFFF', field: '#FBF1E2', ink: '#1A110B', muted: '#4A3A2E', line: '#6B5444', chip: '#F3E3CC', done: '#1F5C32', wait: '#7A4A00', blocked: '#8E1F1A' },
      dark: { bg: '#0F0A07', surface: '#1A1210', field: '#241915', ink: '#FFF8EE', muted: '#E2D2C0', line: '#A8917C', chip: '#33271F', done: '#A6E3B4', wait: '#FFD27A', blocked: '#FFB0A5' }
    }
  };

  /* l / d: standard light and dark. hl / hd: high-contrast light and dark. Each is [accent, on-accent, link]. */
  var THEMES = [
    { id: 'terracotta', name: 'Terracotta', note: 'Default · warm and welcoming', l: ['#B94E28', '#FFFFFF', '#A23F1B'], d: ['#E8855A', '#2A140A', '#F0A07C'], hl: ['#8A2F10', '#FFFFFF', '#7A2A0E'], hd: ['#FFA27A', '#1A0A04', '#FFB898'] },
    { id: 'honey', name: 'Honey', note: 'Sunny and bright', l: ['#E5A020', '#2A1F0A', '#8A5A00'], d: ['#F2B544', '#261A06', '#F5C466'], hl: ['#F2A900', '#1A1100', '#6B4400'], hd: ['#FFC93D', '#1A1100', '#FFD66B'] },
    { id: 'moss', name: 'Moss', note: 'Calm and natural', l: ['#3F7A4E', '#FFFFFF', '#326B41'], d: ['#8FCB9B', '#0E2214', '#A8D8B1'], hl: ['#1F5C32', '#FFFFFF', '#1B4D2B'], hd: ['#A6E3B4', '#04170B', '#BCEBC6'] },
    { id: 'lagoon', name: 'Lagoon', note: 'Fresh and cool', l: ['#1F7A78', '#FFFFFF', '#17696A'], d: ['#5FC4BE', '#07201F', '#86D6D0'], hl: ['#0B5553', '#FFFFFF', '#0A4846'], hd: ['#7FE0DA', '#031A19', '#A0EBE6'] },
    { id: 'indigo', name: 'Indigo', note: 'Deep and bookish', l: ['#4A55B8', '#FFFFFF', '#3E49A8'], d: ['#9AA5F0', '#12153A', '#B1B9F4'], hl: ['#2B338F', '#FFFFFF', '#252C80'], hd: ['#B8C0FF', '#0B0E33', '#CCD2FF'] },
    { id: 'plum', name: 'Plum', note: 'Muted violet-rose', l: ['#8E4A7C', '#FFFFFF', '#7C3C6B'], d: ['#D79BC6', '#2E0F27', '#E3B3D6'], hl: ['#6B2A5C', '#FFFFFF', '#5E2351'], hd: ['#F0B5DF', '#280A20', '#F7CBEA'] },
    { id: 'espresso', name: 'Espresso', note: 'Quiet warm brown', l: ['#5A3E2F', '#FFFFFF', '#4E3426'], d: ['#D2A57C', '#2A1809', '#E0BC98'], hl: ['#3A241A', '#FFFFFF', '#331F16'], hd: ['#F0C9A0', '#1F1006', '#F7D9BA'] },
    { id: 'warmgray', name: 'Warm gray', note: 'Quietest, closest to neutral', l: ['#6B645C', '#FFFFFF', '#57514A'], d: ['#BDB5AA', '#1F1C18', '#D2CBC0'], hl: ['#3F3A34', '#FFFFFF', '#38332E'], hd: ['#E3DDD3', '#181512', '#EFEAE2'] }
  ];

  /* Syntax colours. k keyword, s string, n number, f function, t type, p property, c comment. */
  var CODE = {
    light: { code: '#F6EBDB', head: '#F0E1CC', line: '#E8D9C5', hl: '#F4E9D8', k: '#9A3B6B', s: '#3F6F3A', n: '#A0501A', f: '#2F5F9A', t: '#1F6F6C', p: '#5B3F2E', c: '#7A6454', rem: '#F5DAD2', add: '#DCEBD6', remInk: '#B23A32', addInk: '#3E7B4F' },
    dark: { code: '#17110E', head: '#352920', line: '#43352B', hl: '#2C211A', k: '#E8A0C8', s: '#A6D49A', n: '#F0B27A', f: '#8FB8F0', t: '#7FD4CC', p: '#E0C9B0', c: '#B09C8A', rem: '#3D2220', add: '#223A27', remInk: '#F28C80', addInk: '#8CC59A' },
    lightHC: { code: '#FBF1E2', head: '#F3E3CC', line: '#6B5444', hl: '#EFDCC0', k: '#7A1F52', s: '#1F5C32', n: '#7A3A00', f: '#1B3F7A', t: '#0B4F4C', p: '#3A241A', c: '#4A3A2E', rem: '#F2C9C3', add: '#CFE6C8', remInk: '#8E1F1A', addInk: '#1F5C32' },
    darkHC: { code: '#0F0A07', head: '#33271F', line: '#A8917C', hl: '#2E211A', k: '#FFB5DA', s: '#BDF0B0', n: '#FFD1A0', f: '#B5D3FF', t: '#A6F0EA', p: '#F3E3D0', c: '#D8C6B2', rem: '#4A1F1B', add: '#1D4025', remInk: '#FFB0A5', addInk: '#A6E3B4' }
  };

  var CODE_FONTS = [
    { id: 'jetbrains', name: 'JetBrains Mono', family: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace", google: 'JetBrains+Mono:wght@400;600', note: 'Tall letters, easiest to read' },
    { id: 'dm', name: 'DM Mono', family: "'DM Mono', ui-monospace, Menlo, Consolas, monospace", google: 'DM+Mono:wght@400;500', note: 'Soft and rounded, closest to Nunito' },
    { id: 'source', name: 'Source Code Pro', family: "'Source Code Pro', ui-monospace, Menlo, Consolas, monospace", google: 'Source+Code+Pro:wght@400;600', note: 'Compact, fits more per line' },
    { id: 'fira', name: 'Fira Code', family: "'Fira Code', ui-monospace, Menlo, Consolas, monospace", google: 'Fira+Code:wght@400;600', note: 'Narrow, with ligatures' },
    { id: 'plex', name: 'IBM Plex Mono', family: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace", google: 'IBM+Plex+Mono:wght@400;600', note: 'Wider, more character' }
  ];

  var CODE_KEYS = { code: '--code-bg', head: '--code-head', line: '--code-line', hl: '--code-hl', k: '--code-k', s: '--code-s', n: '--code-n', f: '--code-f', t: '--code-t', p: '--code-p', c: '--code-c', rem: '--code-rem', add: '--code-add', remInk: '--code-rem-ink', addInk: '--code-add-ink' };
  var FOUND_KEYS = { bg: '--bg', surface: '--surface', field: '--field', ink: '--ink', muted: '--muted', line: '--line', chip: '--chip', done: '--done', wait: '--wait', blocked: '--blocked' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var loaded = {};

  function byId(id) { return THEMES.filter(function (t) { return t.id === id; })[0] || THEMES[0]; }
  function codeFontById(id) { return CODE_FONTS.filter(function (f) { return f.id === id; })[0] || CODE_FONTS[0]; }
  function resolveMode(mode) { return mode === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : mode; }

  /* The three theme colours for a mode and contrast level. */
  function accents(th, mode, contrast) {
    var a = contrast === 'high' ? (mode === 'dark' ? th.hd : th.hl) : (mode === 'dark' ? th.d : th.l);
    return { accent: a[0], onAccent: a[1], link: a[2] };
  }
  function palette(id, mode, contrast) {
    var f = FOUNDATION[contrast === 'high' ? 'hc' : 'std'][mode], a = accents(byId(id), mode, contrast);
    return Object.assign({}, f, a);
  }

  /* Code fonts load on demand so only the one in use is fetched. */
  function loadCodeFont(id) {
    var f = codeFontById(id);
    if (loaded[f.id] || !document.head) return;
    loaded[f.id] = true;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + f.google + '&display=swap';
    document.head.appendChild(l);
  }

  function apply(id, mode, contrast, codeFont) {
    var th = byId(id), m = resolveMode(mode), hc = contrast === 'high', root = document.documentElement, st = root.style;
    var p = palette(th.id, m, hc ? 'high' : 'standard');
    Object.keys(FOUND_KEYS).forEach(function (k) { st.setProperty(FOUND_KEYS[k], p[k]); });
    st.setProperty('--accent', p.accent); st.setProperty('--on-accent', p.onAccent); st.setProperty('--link', p.link);
    /* High contrast: 2px borders, underlined links, ink edges on primary buttons */
    st.setProperty('--bw', hc ? '2px' : '1px'); st.setProperty('--bw2', hc ? '2px' : '1.5px');
    st.setProperty('--deco', hc ? 'underline' : 'none');
    st.setProperty('--edge', hc ? p.ink : p.accent); st.setProperty('--obc', hc ? p.link : p.accent);
    st.setProperty('--chipline', hc ? p.line : p.chip);
    var c = CODE[m + (hc ? 'HC' : '')];
    Object.keys(CODE_KEYS).forEach(function (k) { st.setProperty(CODE_KEYS[k], c[k]); });
    var cf = codeFontById(codeFont); st.setProperty('--font-code', cf.family); loadCodeFont(cf.id);
    root.dataset.theme = th.id; root.dataset.mode = m; root.dataset.contrast = hc ? 'high' : 'standard';
    st.colorScheme = m;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p.bg);
  }

  window.Themes = {
    list: THEMES, foundation: FOUNDATION, code: CODE, codeFonts: CODE_FONTS,
    byId: byId, codeFontById: codeFontById, palette: palette, apply: apply, resolveMode: resolveMode, loadCodeFont: loadCodeFont,
    onSystemChange: function (fn) { if (mq && mq.addEventListener) mq.addEventListener('change', fn); }
  };
})();
