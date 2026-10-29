/* Who's using Fuzz: the screen before the app, when the core serves this page and this browser hasn't
   picked yet. Me is your real queue (the token `fuzz serve` printed); Demo is the invented data. The pick
   is remembered, and Settings → Switch account brings this back. One day this is the login. */
(function () {
  var esc = UI.esc;

  /* The link `fuzz serve` printed, or just its token */
  function tokenFrom(text) {
    var m = /[?&]token=([^&#\s]+)/.exec(text);
    return (m ? decodeURIComponent(m[1]) : text).trim();
  }

  /* o: { hasToken, note }. done(pick) runs once the pick is made: 'me' (signed in) or 'demo'. */
  function choose(o, done) {
    var main = document.getElementById('view');
    document.getElementById('fab').hidden = true;
    main.className = 'view view--account';
    document.title = 'Choose account · Fuzz';
    main.innerHTML =
      '<section class="account" aria-labelledby="acct-h">' +
        '<h1 id="acct-h">Who’s using Fuzz?</h1>' +
        (o.note ? '<p class="setup-hint" role="alert">' + esc(o.note) + '</p>' : '') +
        '<div class="acct-picks">' +
          '<button type="button" class="acct-pick" data-pick="me"><span class="acct-n">Me</span><span class="acct-d">Your real queue, from the Fuzz core on this Mac.</span></button>' +
          '<button type="button" class="acct-pick" data-pick="demo"><span class="acct-n">Demo</span><span class="acct-d">Invented tasks to try things out. Nothing reaches your accounts.</span></button>' +
        '</div>' +
        '<form class="acct-key" hidden>' +
          '<div class="field"><label for="acct-tok">The link <code>fuzz serve</code> printed</label>' +
          '<input id="acct-tok" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8765/?token=…"></div>' +
          '<p class="meta acct-help">It’s in <code>~/Library/Application Support/Fuzz/com.fuzz.u1.serve.log</code>. This browser remembers it.</p>' +
          '<p class="acct-err" role="alert"></p>' +
          '<button type="submit" class="btn primary">Continue</button>' +
        '</form>' +
      '</section>';
    var form = main.querySelector('.acct-key'), input = form.querySelector('input'), err = form.querySelector('.acct-err'), go = form.querySelector('[type="submit"]');
    var h1 = main.querySelector('h1'); h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true });

    function signIn(tok) {
      err.textContent = ''; go.disabled = true;
      Live.signIn(tok).then(function () { done('me'); }, function (e) {
        go.disabled = false;
        err.textContent = e.status === 401 ? 'Fuzz doesn’t know that link. Copy the newest one fuzz serve printed.' : 'That didn’t reach Fuzz: ' + e.message;
        form.hidden = false; input.focus();
      });
    }
    main.querySelector('.acct-picks').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]'); if (!b) return;
      if (b.dataset.pick === 'demo') { Live.useDemo(); return done('demo'); }
      if (o.hasToken) return signIn(null);
      form.hidden = false; input.focus();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var tok = tokenFrom(input.value);
      if (!tok) { err.textContent = 'Paste the link first.'; input.focus(); return; }
      signIn(tok);
    });
  }

  window.Account = { choose: choose };
})();
