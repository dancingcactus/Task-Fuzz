#!/bin/sh
# Fuzz, in one paste:
#
#   curl -fsSL https://raw.githubusercontent.com/dancingcactus/Task-Fuzz/main/install.sh | sh
#
# Downloads Fuzz, installs the core in its own Python environment, sets up the store, starts
# `fuzz serve` (a launchd job on a Mac, so it survives a restart) and opens your browser already signed
# in. Everything else happens in the browser. Safe to run again: it updates Fuzz and keeps your data.
#
# FUZZ_REF picks a branch or tag (default main). FUZZ_APP picks where the app goes. FUZZ_HOME picks where
# your data goes (default: ~/Library/Application Support/Fuzz on a Mac, ~/.local/share/fuzz elsewhere).
set -eu

REPO="dancingcactus/Task-Fuzz"
REF="${FUZZ_REF:-main}"
if [ "$(uname -s)" = "Darwin" ]; then
  DATA="$HOME/Library/Application Support/Fuzz"
else
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}/fuzz"
fi
APP="${FUZZ_APP:-$DATA/app}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Fuzz couldn’t finish: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl isn’t installed."
command -v tar >/dev/null 2>&1 || fail "tar isn’t installed."

# ---- Fuzz itself: a fresh copy each time, swapped in whole so a running server never sees half of it
say "Getting Fuzz ($REF)…"
mkdir -p "$APP"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TMP/fuzz.tar.gz" || fail "couldn’t download Fuzz ($REF)."
mkdir -p "$TMP/src"
tar -xzf "$TMP/fuzz.tar.gz" -C "$TMP/src" --strip-components 1
[ -f "$TMP/src/core/pyproject.toml" ] || fail "the download doesn’t look like Fuzz."
rm -rf "$APP/src.old"
[ -d "$APP/src" ] && mv "$APP/src" "$APP/src.old"
mv "$TMP/src" "$APP/src"
rm -rf "$APP/src.old"

# ---- Python 3.11 or newer, in Fuzz's own environment
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }
PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1 && py_ok "$c"; then PY="$(command -v "$c")"; break; fi
done
VENV="$APP/venv"
if [ -x "$VENV/bin/python" ] && py_ok "$VENV/bin/python"; then
  :
elif [ -n "$PY" ]; then
  say "Setting up Python…"
  "$PY" -m venv "$VENV" || fail "couldn’t make a Python environment with $PY."
else
  # No new enough Python: uv fetches one, without touching the system's
  say "Fetching Python 3.12 (this Mac’s is older than Fuzz needs)…"
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null || fail "couldn’t install uv to fetch Python."
    PATH="$HOME/.local/bin:$PATH"
  fi
  uv venv --python 3.12 --seed "$VENV" >/dev/null || fail "couldn’t fetch Python 3.12."
fi

say "Installing the Fuzz core…"
"$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
# Editable, so the core serves the UI next to it and launchd's jobs find it in place
"$VENV/bin/python" -m pip install --quiet -e "$APP/src/core" || fail "couldn’t install the core’s Python packages."

FUZZ="$VENV/bin/fuzz"
"$FUZZ" init >/dev/null 2>&1 || fail "couldn’t set up your Fuzz data in $DATA."

# A `fuzz` command on your PATH, if ~/.local/bin is there. Nothing in the setup needs it.
if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  ln -sf "$FUZZ" "$HOME/.local/bin/fuzz" 2>/dev/null || true
fi

say "Starting Fuzz…"
"$FUZZ" start --restart || fail "Fuzz didn’t start. Run $FUZZ serve to see why."
say ""
say "Done. Fuzz is open in your browser. You can close this window."
