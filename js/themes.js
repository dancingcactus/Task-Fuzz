/* The eight palettes from "Warm Palette Explorations", each in light and dark.
   Token names match the explorations: bg, surface, field, ink, muted, line, accent,
   onAccent (text on accent), link, sec (secondary accent), chip. */
(function () {
  var T = [
    { id: 'terracotta', name: 'Terracotta', full: 'Terracotta & Cream',
      light: { bg: '#FBF3E8', surface: '#FFFBF4', field: '#F6EBDB', ink: '#3A2A20', muted: '#7A6454', line: '#E8D9C5', accent: '#B94E28', onAccent: '#FFFFFF', link: '#A23F1B', sec: '#5F7F5B', chip: '#F0E1CC' },
      dark:  { bg: '#1E1612', surface: '#2A201A', field: '#352920', ink: '#F4E8DB', muted: '#C2AB98', line: '#43352B', accent: '#E8855A', onAccent: '#2A140A', link: '#F0A07C', sec: '#9DBB8F', chip: '#3B2D23' } },
    { id: 'honey', name: 'Honey', full: 'Honey & Walnut',
      light: { bg: '#FAF1DC', surface: '#FFFAEC', field: '#F5E8C8', ink: '#3A2C14', muted: '#77633F', line: '#E6D5A8', accent: '#E5A020', onAccent: '#2A1F0A', link: '#8A5A00', sec: '#6B4A32', chip: '#F2E1B3' },
      dark:  { bg: '#1C1710', surface: '#2A2217', field: '#352C1D', ink: '#F6EAD0', muted: '#C9B48D', line: '#44392A', accent: '#F2B544', onAccent: '#261A06', link: '#F5C466', sec: '#C49A6C', chip: '#3D3322' } },
    { id: 'rosewood', name: 'Rosewood', full: 'Rosewood & Blush',
      light: { bg: '#FBEFEC', surface: '#FFF8F6', field: '#F6E2DE', ink: '#3B2428', muted: '#7D5C62', line: '#EBD0CB', accent: '#A93F55', onAccent: '#FFFFFF', link: '#9A3248', sec: '#B8862F', chip: '#F3DAD5' },
      dark:  { bg: '#211618', surface: '#2E2023', field: '#3A292D', ink: '#F7E6E4', muted: '#CDAEB1', line: '#4A3539', accent: '#E8798C', onAccent: '#2B0D14', link: '#F29AA9', sec: '#E0B261', chip: '#402D31' } },
    { id: 'persimmon', name: 'Persimmon', full: 'Persimmon & Olive',
      light: { bg: '#F6F0E1', surface: '#FCF8EE', field: '#EEE6D0', ink: '#2E2A1C', muted: '#6D664B', line: '#DDD3B5', accent: '#C24E1A', onAccent: '#FFFFFF', link: '#A8400F', sec: '#6B7A3A', chip: '#E8DFC3' },
      dark:  { bg: '#1A1A12', surface: '#26261A', field: '#30301F', ink: '#F2EEDB', muted: '#BDB89A', line: '#3F3F2C', accent: '#F08A52', onAccent: '#2A1306', link: '#F5A375', sec: '#A9B66B', chip: '#38382A' } },
    { id: 'denim', name: 'Denim', full: 'Sand & Denim',
      light: { bg: '#F7F1E6', surface: '#FDFAF3', field: '#EFE7D6', ink: '#2D2B2A', muted: '#6B6558', line: '#E2D8C2', accent: '#2F5FA8', onAccent: '#FFFFFF', link: '#2A55A0', sec: '#D08A3C', chip: '#E9E0CB' },
      dark:  { bg: '#1B1916', surface: '#262420', field: '#302D28', ink: '#F3EEE4', muted: '#BDB5A5', line: '#3E3A33', accent: '#7FAAE6', onAccent: '#0F1B2E', link: '#9DBDEE', sec: '#E0A765', chip: '#38342D' } },
    { id: 'plum', name: 'Plum', full: 'Oat & Plum',
      light: { bg: '#F8F1EA', surface: '#FEFAF5', field: '#F0E6DD', ink: '#2E2630', muted: '#6E6070', line: '#E5D6CC', accent: '#6B4BA8', onAccent: '#FFFFFF', link: '#5E3F9C', sec: '#D4875A', chip: '#EBDDE6' },
      dark:  { bg: '#1C171E', surface: '#281F2B', field: '#332938', ink: '#F4EAF3', muted: '#C7B5C9', line: '#43364A', accent: '#B79CEB', onAccent: '#1D0F33', link: '#C9B3F0', sec: '#E8A27C', chip: '#3B2E41' } },
    { id: 'moss', name: 'Moss', full: 'Cream & Moss',
      light: { bg: '#F5F1E3', surface: '#FCFAF0', field: '#ECE8D3', ink: '#2A2E24', muted: '#636A55', line: '#DAD8BC', accent: '#3F7A4E', onAccent: '#FFFFFF', link: '#326B41', sec: '#C9803A', chip: '#E3E3C8' },
      dark:  { bg: '#171A14', surface: '#21261D', field: '#2B3126', ink: '#EEF0E0', muted: '#B5BCA3', line: '#384031', accent: '#8FCB9B', onAccent: '#0E2214', link: '#A8D8B1', sec: '#E0A15E', chip: '#333B2D' } },
    { id: 'lagoon', name: 'Lagoon', full: 'Linen & Lagoon',
      light: { bg: '#F6F1E7', surface: '#FDFAF3', field: '#EDE8DA', ink: '#262C2B', muted: '#58635F', line: '#DCD7C4', accent: '#1F7A78', onAccent: '#FFFFFF', link: '#17696A', sec: '#D9825B', chip: '#E2E6D6' },
      dark:  { bg: '#151A19', surface: '#1F2625', field: '#29322F', ink: '#ECF1E8', muted: '#AFBDB6', line: '#34403C', accent: '#5FC4BE', onAccent: '#07201F', link: '#86D6D0', sec: '#E89A74', chip: '#2D3835' } }
  ];

  var KEYS = { bg: '--bg', surface: '--surface', field: '--field', ink: '--ink', muted: '--muted', line: '--line', accent: '--accent', onAccent: '--on-accent', link: '--link', sec: '--sec', chip: '--chip' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function byId(id) { return T.filter(function (t) { return t.id === id; })[0] || T[0]; }
  function resolveMode(mode) { return mode === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : mode; }

  function apply(id, mode) {
    var th = byId(id), m = resolveMode(mode), p = th[m], root = document.documentElement;
    Object.keys(KEYS).forEach(function (k) { root.style.setProperty(KEYS[k], p[k]); });
    root.dataset.theme = th.id;
    root.dataset.mode = m;
    root.style.colorScheme = m;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p.bg);
  }

  window.Themes = {
    list: T,
    byId: byId,
    apply: apply,
    resolveMode: resolveMode,
    onSystemChange: function (fn) { if (mq && mq.addEventListener) mq.addEventListener('change', fn); }
  };
})();
