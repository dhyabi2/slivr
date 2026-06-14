#!/usr/bin/env bash
# slivr — one-line installer.   curl -fsSL <raw>/install.sh | bash
# Puts the `slivr` coding agent on your PATH. Pure Node (>= 18), no build, no npm deps.
set -euo pipefail

REPO="${SLIVR_REPO:-https://github.com/dhyabi2/slivr}"
# REF is overridable via env to pin a tag/commit:  REF=v1.2.3 curl ... | bash
# (SLIVR_REF kept for back-compat; plain REF takes precedence if set.)
REF="${REF:-${SLIVR_REF:-main}}"
DEST="${SLIVR_DEST:-$HOME/.slivr-src}"
BIN_DIR="${SLIVR_BIN_DIR:-/usr/local/bin}"

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

node "$DEST/bin/slivr.mjs" --version >/dev/null || err "install verification failed"
chmod +x "$DEST/bin/slivr.mjs"

LINK="$BIN_DIR/slivr"
if { [ -w "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null; } && [ -w "$BIN_DIR" ]; then
  ln -sf "$DEST/bin/slivr.mjs" "$LINK"
else
  BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; LINK="$BIN_DIR/slivr"
  ln -sf "$DEST/bin/slivr.mjs" "$LINK"
  # $BIN_DIR is the fallback dir; persist it on PATH so `slivr` is found in a new shell.
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
        printf '\n# Added by slivr installer\n%s\n' "$EXPORT_LINE" >> "$RC"
        say "Added $BIN_DIR to your PATH in $RC"
      fi
      say "Run:  source $RC   (or open a new terminal) to pick up the change."
      ;;
  esac
fi

say "Installed: $(node "$DEST/bin/slivr.mjs" --version)  ->  $LINK  (in $BIN_DIR)"
say "Set your key:  export OPENROUTER_API_KEY=sk-or-...   (https://openrouter.ai/keys)"
say "Run:  slivr        (interactive)   |   slivr \"<task>\" ./repo   (one-shot)"
