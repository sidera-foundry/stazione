#!/bin/bash
# Connects this Mac or Linux computer to Stazione with one command, copied from the station's Account page:
#   bash <(curl -fsSL https://<station>/connect.sh) https://<station> <connection code>
# It downloads the agent client from the station, trades the single-use code for the token (Mac: kept in the Keychain;
# Linux: ~/.config/stazione/env, readable only by you; never shown), writes the protocol for the coding agent in the
# folder of your projects and tests the connection. Nothing else is installed. Run it in the folder of your projects.
set -u
URL="${1:-}"; CODE="${2:-}"
SERVICE="stazione"

yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

echo
yellow "=== STAZIONE: connecting this computer ==="
echo

URL="${URL%/}"
[[ "$URL" =~ ^(https://[^[:space:]/]+|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)$ ]] || fail "The command is incomplete: copy it again from the Account page of the station."
[[ "$CODE" =~ ^stzc_[A-Za-z0-9_-]{20,30}$ ]] || fail "The connection code is missing: copy the command again from the Account page of the station."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Download it from https://nodejs.org (LTS version), install it and run the command again."
command -v curl >/dev/null 2>&1 || fail "curl is needed: install it and run the command again."
MAC=0; [ "$(uname -s)" = "Darwin" ] && MAC=1

# 1. Which agent works here: it decides the protocol file (same rules, the file name each agent reads)
echo "Which coding agent will work on this computer?"
echo "  1) Claude Code  (writes CLAUDE.md)"
echo "  2) Codex, or another agent that reads AGENTS.md"
KIND=""
while [ "$KIND" != "1" ] && [ "$KIND" != "2" ]; do read -r -p "Choose 1 or 2: " KIND; done
if [ "$KIND" = "1" ]; then FILE="CLAUDE.md"; TEMPLATE="CLAUDE.template.md"; KEY="CLAUDE"
else FILE="AGENTS.md"; TEMPLATE="AGENTS.template.md"; KEY="AGENT"; fi

# 2. Name of the instance
NAME=""
while [ ${#NAME} -lt 2 ] || [ ${#NAME} -gt 40 ]; do
  read -r -p "What is your agent called? (e.g. Atlas) " NAME
  NAME="$(printf '%s' "$NAME" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
done
ID="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40 | sed -E 's/-+$//')"
[ ${#ID} -lt 2 ] && ID="agent-$ID"
cyan "Identity: $NAME  (id: $ID)"

# 3. Folder of the projects: the protocol goes there, so the agent finds it in every project inside it
echo
read -r -p "Folder that holds your projects [$PWD]: " PROJECTS
PROJECTS="${PROJECTS:-$PWD}"
PROJECTS="${PROJECTS/#\~/$HOME}"
[ -d "$PROJECTS" ] || fail "The folder $PROJECTS does not exist."
TARGET="$PROJECTS/$FILE"

# 4. The client and the protocol template, from this station
DIR="$HOME/.stazione"
mkdir -p "$DIR"
CLI="$DIR/stazione.mjs"
curl -fsSL "$URL/stazione.mjs" -o "$CLI" || fail "Could not download the client from $URL"
TPL="$(mktemp)"
curl -fsSL "$URL/$TEMPLATE" -o "$TPL" || fail "Could not download the protocol from $URL"

# 5. The token, once, in exchange for the code (it goes straight to its safe place, never on screen)
REPLY_FILE="$(mktemp)"; chmod 600 "$REPLY_FILE"
curl -sS -X POST -H 'content-type: application/json' --data "{\"code\":\"$CODE\"}" "$URL/api/connect/claim" -o "$REPLY_FILE" || { rm -f "$REPLY_FILE"; fail "Could not reach $URL"; }
TOKEN="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!/^stz_/.test(j.token||"")) { console.error(j.error||"no token"); process.exit(1); } process.stdout.write(j.token);' "$REPLY_FILE" 2>"$REPLY_FILE.err")"
STATUS=$?
rm -f "$REPLY_FILE"
if [ $STATUS -ne 0 ]; then MSG="$(cat "$REPLY_FILE.err")"; rm -f "$REPLY_FILE.err"; fail "The station refused the code: $MSG"; fi
rm -f "$REPLY_FILE.err"

BLOCK_START="# >>> stazione >>>"
BLOCK_END="# <<< stazione <<<"
if [ $MAC = 1 ]; then
  security add-generic-password -U -s "$SERVICE" -a "$USER" -w "$TOKEN" -T /usr/bin/security >/dev/null 2>&1 || fail "Could not save the token in the Keychain."
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
  green "Token saved in the Keychain (item: $SERVICE); shell configured (~/.zshrc and ~/.bash_profile)."
else
  mkdir -p "$HOME/.config/stazione"
  ENVF="$HOME/.config/stazione/env"
  ( umask 077; printf 'STAZIONE_URL=%s\nSTAZIONE_TOKEN=%s\n' "$URL" "$TOKEN" > "$ENVF" )
  chmod 600 "$ENVF"
  green "Token saved in $ENVF (readable only by you)."
fi
unset TOKEN

# 6. The protocol file with this computer's identity
if [ -f "$TARGET" ]; then cp "$TARGET" "$TARGET.bak"; echo "The existing $FILE was saved as $FILE.bak"; fi
NAME="$NAME" ID="$ID" CLI="$CLI" TEMPLATE="$TPL" TARGET="$TARGET" KEY="$KEY" node -e '
  const fs = require("fs");
  const { NAME, ID, CLI, TEMPLATE, TARGET, KEY } = process.env;
  let t = fs.readFileSync(TEMPLATE, "utf8");
  t = t.replace(new RegExp(`^${KEY}_NAME\\s*=.*$`, "m"), () => `${KEY}_NAME  = "${NAME}"`)
       .replace(new RegExp(`^${KEY}_ID\\s*=.*$`, "m"), () => `${KEY}_ID    = "${ID}"`)
       .replace(/^STAZIONE_CLI\s*=.*$/m, () => `STAZIONE_CLI = "${CLI}"`);
  fs.writeFileSync(TARGET, t);
' || fail "Cannot write $TARGET"
rm -f "$TPL"
green "Protocol written to $TARGET"

# 7. Connection test (the client reads the token from where it was just saved)
echo
echo "Connecting to the station..."
if [ $MAC = 1 ]; then
  STAZIONE_TOKEN="$(security find-generic-password -s "$SERVICE" -a "$USER" -w 2>/dev/null)" STAZIONE_URL="$URL" node "$CLI" hello --as "$ID" --name "$NAME" >/tmp/stazione-hello.$$ 2>&1
else
  node "$CLI" hello --as "$ID" --name "$NAME" >/tmp/stazione-hello.$$ 2>&1
fi
STATUS=$?
OUT="$(cat /tmp/stazione-hello.$$)"; rm -f /tmp/stazione-hello.$$
if [ $STATUS -ne 0 ]; then
  case "$OUT" in
    *"another user"*) fail "The name '$NAME' is already used by another user. Run the command again with a new token and another name." ;;
    *) fail "Connection failed: $OUT" ;;
  esac
fi
echo
green "DONE! $NAME is on board Stazione."
echo
yellow "Last step: quit your coding agent completely and open it again in $PROJECTS (or in a project inside it), then tell it: connect to the station"
