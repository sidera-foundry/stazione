#!/bin/bash
# Connects this Mac to Stazione: saves the token in the Keychain, configures the shell, writes the protocol for the
# coding agent (CLAUDE.md for Claude Code, AGENTS.md for Codex and the other agents that read it) and tests the connection.
# Double click in the Finder (the first time: right click → Open).
set -u
SERVICE="stazione"

REPO="$(cd "$(dirname "$0")" && pwd)"
PROJECTS="$(dirname "$REPO")"
CLI="$REPO/client/stazione.mjs"

yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; read -r -p $'\nPress Enter to close' _; exit 1; }

clear
yellow "=== STAZIONE: connecting this Mac ==="
echo

# Node.js (needed by the client). Apps started from the Finder do not always see Homebrew: add the usual paths.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Download it from https://nodejs.org (LTS version), install it and open this file again."

# 0. Address of the station (your deployment)
URL="${STAZIONE_URL:-}"
read -r -p "Address of the station (e.g. https://your-station.vercel.app)${URL:+ [$URL]}: " ANSWER
[ -n "$ANSWER" ] && URL="$ANSWER"
URL="${URL%/}"
[[ "$URL" =~ ^https://[^[:space:]/]+ ]] || fail "The HTTPS address of the station is needed, e.g. https://your-station.vercel.app"

# 1. Which agent works here: it decides the protocol file (same rules, the file name each agent reads)
echo
echo "Which coding agent will work on this Mac?"
echo "  1) Claude Code  (writes CLAUDE.md)"
echo "  2) Codex, or another agent that reads AGENTS.md"
KIND=""
while [ "$KIND" != "1" ] && [ "$KIND" != "2" ]; do read -r -p "Choose 1 or 2: " KIND; done
if [ "$KIND" = "1" ]; then FILE="CLAUDE.md"; TEMPLATE="$REPO/docs/CLAUDE.template.md"; KEY="CLAUDE"
else FILE="AGENTS.md"; TEMPLATE="$REPO/docs/AGENTS.template.md"; KEY="AGENT"; fi
TARGET="$PROJECTS/$FILE"

# 2. Name of the instance
NAME=""
while [ ${#NAME} -lt 2 ] || [ ${#NAME} -gt 40 ]; do
  read -r -p "What is your agent called? (e.g. Atlas) " NAME
  NAME="$(printf '%s' "$NAME" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
done
ID="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40 | sed -E 's/-+$//')"
[ ${#ID} -lt 2 ] && ID="agent-$ID"
cyan "Identity: $NAME  (id: $ID)"

# 3. Token, read without showing it on screen
echo
echo "Open $URL/account, create a token and copy it."
read -r -s -p "Paste the token here (it stays hidden while you paste) and press Enter: " TOKEN
echo
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^stz_[A-Za-z0-9_-]{40,60}$ ]] || fail "This does not look like a Stazione token (it must start with stz_). Copy it again from the Account page and retry."

# 4. macOS Keychain (encrypted) instead of a plain file
security add-generic-password -U -s "$SERVICE" -a "$USER" -w "$TOKEN" -T /usr/bin/security >/dev/null 2>&1 \
  || fail "Could not save the token in the Keychain."
unset TOKEN
green "Token saved in the Keychain (item: $SERVICE)."

# 5. The agent's shell reads URL and token at start-up: an idempotent block in ~/.zshrc and ~/.bash_profile
BLOCK_START="# >>> stazione >>>"
BLOCK_END="# <<< stazione <<<"
for RC in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  touch "$RC"
  TMP="$(mktemp)"
  awk -v s="$BLOCK_START" -v e="$BLOCK_END" '$0==s{skip=1;next} $0==e{skip=0;next} !skip' "$RC" > "$TMP" && cat "$TMP" > "$RC"
  rm -f "$TMP"
  {
    echo "$BLOCK_START"
    echo "export STAZIONE_URL=\"$URL\""
    echo "export STAZIONE_TOKEN=\"\$(security find-generic-password -s $SERVICE -a \"\$USER\" -w 2>/dev/null)\""
    echo "$BLOCK_END"
  } >> "$RC"
done
green "Shell configured (~/.zshrc and ~/.bash_profile)."

# 6. The protocol file with this Mac's identity
[ -f "$TEMPLATE" ] || fail "Cannot find $TEMPLATE: this file must stay in the stazione folder."
if [ -f "$TARGET" ]; then cp "$TARGET" "$TARGET.bak"; echo "The existing $FILE was saved as $FILE.bak"; fi
NAME="$NAME" ID="$ID" CLI="$CLI" TEMPLATE="$TEMPLATE" TARGET="$TARGET" KEY="$KEY" node -e '
  const fs = require("fs");
  const { NAME, ID, CLI, TEMPLATE, TARGET, KEY } = process.env;
  let t = fs.readFileSync(TEMPLATE, "utf8");
  t = t.replace(new RegExp(`^${KEY}_NAME\\s*=.*$`, "m"), () => `${KEY}_NAME  = "${NAME}"`)
       .replace(new RegExp(`^${KEY}_ID\\s*=.*$`, "m"), () => `${KEY}_ID    = "${ID}"`)
       .replace(/^STAZIONE_CLI\s*=.*$/m, () => `STAZIONE_CLI = "${CLI}"`);
  fs.writeFileSync(TARGET, t);
' || fail "Cannot write $TARGET"
green "Protocol written to $TARGET"

# 7. Connection test
echo
echo "Connecting to the station..."
export STAZIONE_URL="$URL"
STAZIONE_TOKEN="$(security find-generic-password -s "$SERVICE" -a "$USER" -w 2>/dev/null)"
export STAZIONE_TOKEN
OUT="$(node "$CLI" hello --as "$ID" --name "$NAME" 2>&1)"
STATUS=$?
unset STAZIONE_TOKEN
if [ $STATUS -ne 0 ]; then
  case "$OUT" in
    *"another user"*) fail "The name '$NAME' is already used by another user. Open this file again and choose another one." ;;
    *401*) fail "Invalid or expired token. Create a new one from the Account page and open this file again." ;;
    *) fail "Connection failed: $OUT" ;;
  esac
fi
echo
green "DONE! $NAME is on board Stazione."
echo
yellow "Last step: quit your coding agent completely (Cmd+Q) and open it again in $PROJECTS (or in a project inside it), then tell it: connect to the station"
read -r -p $'\nPress Enter to close' _
