#!/usr/bin/env bash
# proov — one-line installer.   curl -fsSL <raw>/install.sh | bash
# Puts the `proov` coding agent on your PATH. Pure Node (>= 18), no build, no npm deps.
set -euo pipefail

REPO="${PROOV_REPO:-https://github.com/dhyabi2/proov}"
# REF is overridable via env to pin a tag/commit:  REF=v1.2.3 curl ... | bash
# (PROOV_REF kept for back-compat; plain REF takes precedence if set.)
REF="${REF:-${PROOV_REF:-main}}"
DEST="${PROOV_DEST:-$HOME/.proov-src}"
BIN_DIR="${PROOV_BIN_DIR:-/usr/local/bin}"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js >= 18 is required (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || err "Node >= 18 required; found $(node -v)"
command -v git >/dev/null 2>&1 || err "git is required"

if [ -d "$DEST/.git" ]; then
  say "Updating $DEST"
  git -C "$DEST" fetch -q --depth 1 origin "$REF" && git -C "$DEST" reset -q --hard "origin/$REF"
else
  say "Cloning $REPO -> $DEST"
  rm -rf "$DEST"; git clone -q --depth 1 --branch "$REF" "$REPO" "$DEST"
fi

node "$DEST/bin/proov.mjs" --version >/dev/null || err "install verification failed"
chmod +x "$DEST/bin/proov.mjs"

LINK="$BIN_DIR/proov"
if { [ -w "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null; } && [ -w "$BIN_DIR" ]; then
  ln -sf "$DEST/bin/proov.mjs" "$LINK"
else
  BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; LINK="$BIN_DIR/proov"
  ln -sf "$DEST/bin/proov.mjs" "$LINK"
  # $BIN_DIR is the fallback dir; persist it on PATH so `proov` is found in a new shell.
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
      case "${SHELL##*/}" in
        zsh)  RC="$HOME/.zshrc" ;;
        bash) RC="$HOME/.bashrc" ;;
        *)    RC="$HOME/.profile" ;;
      esac
      if [ -f "$RC" ] && grep -qF "$EXPORT_LINE" "$RC"; then
        say "PATH already configured in $RC"
      else
        printf '\n# Added by proov installer\n%s\n' "$EXPORT_LINE" >> "$RC"
        say "Added $BIN_DIR to your PATH in $RC"
      fi
      say "Run:  source $RC   (or open a new terminal) to pick up the change."
      ;;
  esac
fi

say "Installed: $(node "$DEST/bin/proov.mjs" --version)  ->  $LINK  (in $BIN_DIR)"
say "Set your key:  export OPENROUTER_API_KEY=sk-or-...   (https://openrouter.ai/keys)"
say "Run:  proov        (interactive)   |   proov \"<task>\" ./repo   (one-shot)"
