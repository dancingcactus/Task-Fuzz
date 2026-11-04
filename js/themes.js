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
    { id: 'warmgray', name: 'Warm gray', note: 'Quietest, closest to neutral', l: ['#6B645C', '#FFFFFF', '#57514A'], d: ['#BDB5AA', '#1F1C18', '#D2CBC0'], hl: ['#3F3A34', '#FFFFFF', '#38332E'], hd: ['#E3DDD3', '#181512', '#EFEAE2'] },
    /* Retro: a black-and-white TV. It brings its own grey foundation and code colours (status keeps only a
       faint tint, and its icon), and the stylesheet adds scan lines and a vignette. Random never picks it. */
    { id: 'retro', name: 'Retro', note: 'Black-and-white TV', retro: true, special: true,
      l: ['#3A3A3A', '#FFFFFF', '#2E2E2E'], d: ['#CFCFCB', '#141414', '#E2E2DE'], hl: ['#111111', '#FFFFFF', '#111111'], hd: ['#F2F2EE', '#000000', '#FFFFFF'],
      foundation: {
        std: {
          light: { bg: '#E4E4E1', surface: '#F1F1EE', field: '#D9D9D5', ink: '#1C1C1C', muted: '#5C5C59', line: '#C2C2BE', chip: '#D0D0CC', done: '#4B584D', wait: '#675E4E', blocked: '#6B4D4A' },
          dark: { bg: '#121212', surface: '#1C1C1C', field: '#262626', ink: '#E6E6E2', muted: '#A2A29F', line: '#383838', chip: '#2B2B2B', done: '#A8B6AA', wait: '#C7BDA8', blocked: '#C6A8A4' }
        },
        hc: {
          light: { bg: '#F2F2F0', surface: '#FFFFFF', field: '#E6E6E3', ink: '#000000', muted: '#383838', line: '#585858', chip: '#DEDEDA', done: '#2C392E', wait: '#463D2C', blocked: '#4B2C29' },
          dark: { bg: '#000000', surface: '#0D0D0D', field: '#191919', ink: '#FFFFFF', muted: '#D2D2CE', line: '#989898', chip: '#252525', done: '#C6D6C9', wait: '#E4DAC4', blocked: '#E4C6C2' }
        }
      },
      code: {
        light: { code: '#D9D9D5', head: '#D0D0CC', line: '#C2C2BE', hl: '#CDCDC9', k: '#1A1A1A', s: '#4E4E4E', n: '#5A5A5A', f: '#262626', t: '#3A3A3A', p: '#303030', c: '#7A7A77', rem: '#D6CFCD', add: '#CDD4CE', remInk: '#5C3E3B', addInk: '#3C493E' },
        dark: { code: '#0E0E0E', head: '#262626', line: '#383838', hl: '#222222', k: '#F2F2EE', s: '#B4B4B0', n: '#C6C6C2', f: '#E0E0DC', t: '#CACAC6', p: '#D6D6D2', c: '#8E8E8B', rem: '#2E2524', add: '#232A24', remInk: '#C6A8A4', addInk: '#A8B6AA' }
      } },
    /* Technicolor: early colour film. Warm cream stock, saturated carmine and teal (the two strips), golden
       highlights, and faint warm scan lines, a warm vignette and a little grain from the stylesheet. Random never picks it either. */
    { id: 'technicolor', name: 'Technicolor', note: 'Early colour film', special: true,
      l: ['#B8202B', '#FFF6E8', '#14706A'], d: ['#FF6A55', '#2A0A06', '#56C9BC'], hl: ['#8C1018', '#FFFFFF', '#0B524D'], hd: ['#FF8A78', '#1C0503', '#7FE0D4'],
      foundation: {
        std: {
          light: { bg: '#F4E3C8', surface: '#FCF1DE', field: '#EED8B6', ink: '#2A120E', muted: '#6E4A3A', line: '#E2C49C', chip: '#EBCFA6', done: '#1F7A5E', wait: '#B0700A', blocked: '#A8162A' },
          dark: { bg: '#170C0B', surface: '#241411', field: '#311C17', ink: '#FBEBD3', muted: '#D2AE92', line: '#4A2C23', chip: '#3A221B', done: '#5FD0A6', wait: '#F2B640', blocked: '#FF7A84' }
        },
        hc: {
          light: { bg: '#FBEEDA', surface: '#FFFAF1', field: '#F3E0C2', ink: '#160806', muted: '#4A2A1E', line: '#7A4E36', chip: '#EED7B2', done: '#0F5A43', wait: '#7A4C00', blocked: '#7E0C1D' },
          dark: { bg: '#0C0504', surface: '#1A0D0B', field: '#26130F', ink: '#FFF6E6', muted: '#EED3B8', line: '#B08868', chip: '#331C16', done: '#86E8C2', wait: '#FFD27A', blocked: '#FFA5AC' }
        }
      },
      code: {
        light: { code: '#EED8B6', head: '#EBCFA6', line: '#E2C49C', hl: '#F2DEBE', k: '#B8202B', s: '#14706A', n: '#B05A00', f: '#7A1E5A', t: '#0F6A63', p: '#5A2A1A', c: '#7E5A48', rem: '#F2CDBF', add: '#CFE6D2', remInk: '#A8162A', addInk: '#1F7A5E' },
        dark: { code: '#120807', head: '#311C17', line: '#4A2C23', hl: '#2A1713', k: '#FF6A55', s: '#56C9BC', n: '#F5A84A', f: '#F08AC4', t: '#7FE0D4', p: '#F2D2B0', c: '#B8917A', rem: '#3E1A18', add: '#163A2E', remInk: '#FF7A84', addInk: '#5FD0A6' }
      } }
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
    var th = byId(id), f = (th.foundation || FOUNDATION)[contrast === 'high' ? 'hc' : 'std'][mode], a = accents(th, mode, contrast);
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
    var c = th.code ? th.code[m] : CODE[m + (hc ? 'HC' : '')];
    Object.keys(CODE_KEYS).forEach(function (k) { st.setProperty(CODE_KEYS[k], c[k]); });
    var cf = codeFontById(codeFont); st.setProperty('--font-code', cf.family); loadCodeFont(cf.id);
    root.dataset.theme = th.id; root.dataset.mode = m; root.dataset.contrast = hc ? 'high' : 'standard';
    st.colorScheme = m;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p.bg);
  }

  /* Random: a different theme each time Fuzz opens, never a special one (Retro, Technicolor) and never the one shown last time */
  var LAST = 'fuzz.theme.last';
  function pickRandom() {
    var last = null; try { last = localStorage.getItem(LAST); } catch (e) {}
    var pool = THEMES.filter(function (t) { return !t.special && t.id !== last; });
    var t = pool[Math.floor(Math.random() * pool.length)];
    try { localStorage.setItem(LAST, t.id); } catch (e) {}
    return t.id;
  }

  window.Themes = {
    list: THEMES, pickRandom: pickRandom, foundation: FOUNDATION, code: CODE, codeFonts: CODE_FONTS,
    byId: byId, codeFontById: codeFontById, palette: palette, apply: apply, resolveMode: resolveMode, loadCodeFont: loadCodeFont,
    onSystemChange: function (fn) { if (mq && mq.addEventListener) mq.addEventListener('change', fn); }
  };
})();
