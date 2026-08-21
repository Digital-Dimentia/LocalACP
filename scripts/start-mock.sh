#!/usr/bin/env bash
# Launch acp-ui against fixtures/mock-acp-agent.mjs, the agent that reproduces
# https://github.com/formulahendry/acp-ui/issues/9 (tool calls arriving before
# any assistant message). Registering it by hand means finding the per-platform
# agents.json and writing an absolute path into it; this does that step for you.
#
#   ./scripts/start-mock.sh            # register the agent, then `npm run tauri dev`
#   ./scripts/start-mock.sh --setup    # register only, don't launch
#   ./scripts/start-mock.sh --ws [port]  # run the fixture as a WebSocket agent
#                                        # for the web build (default port 8791)
#
# Set ACP_UI_AGENTS_FILE to point the registration at a different config file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$REPO_DIR/fixtures/mock-acp-agent.mjs"
AGENT_NAME="mock-issue9"

[ -f "$FIXTURE" ] || { echo "error: fixture not found at $FIXTURE" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node is required" >&2; exit 1; }

# WebSocket mode is for the web build, which only talks to remote agents. It
# needs no config file — you add the ws:// URL in the app's agent settings.
if [ "${1:-}" = "--ws" ]; then
  port="${2:-8791}"
  echo "Starting mock agent on ws://127.0.0.1:$port"
  echo "Add it in the web build as a WebSocket agent, then send any prompt."
  exec node "$FIXTURE" --ws "$port"
fi

# Mirrors dirs::config_dir() in src-tauri/src/config.rs, which is where the
# desktop build reads agents.json from.
default_agents_file() {
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Application Support/acp-ui/agents.json" ;;
    MINGW*|MSYS*|CYGWIN*) echo "${APPDATA:-$HOME/AppData/Roaming}/acp-ui/agents.json" ;;
    *) echo "${XDG_CONFIG_HOME:-$HOME/.config}/acp-ui/agents.json" ;;
  esac
}

AGENTS_FILE="${ACP_UI_AGENTS_FILE:-$(default_agents_file)}"
mkdir -p "$(dirname "$AGENTS_FILE")"

# Merge rather than overwrite: the file usually holds the user's real agents.
# Node does the JSON surgery so a hand-formatted config survives intact.
AGENTS_FILE="$AGENTS_FILE" FIXTURE="$FIXTURE" AGENT_NAME="$AGENT_NAME" node - <<'NODE'
const fs = require('node:fs');
const { AGENTS_FILE, FIXTURE, AGENT_NAME } = process.env;

let config = { agents: {} };
if (fs.existsSync(AGENTS_FILE)) {
  const raw = fs.readFileSync(AGENTS_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.agents) config = parsed;
    else if (parsed && typeof parsed === 'object') config = { ...parsed, agents: {} };
  } catch (e) {
    console.error(`error: ${AGENTS_FILE} is not valid JSON (${e.message}).`);
    console.error('Fix or move it before running this script — refusing to overwrite it.');
    process.exit(1);
  }
}

const wanted = { command: 'node', args: [FIXTURE] };
const existing = config.agents[AGENT_NAME];
if (existing && JSON.stringify(existing) === JSON.stringify(wanted)) {
  console.log(`Agent '${AGENT_NAME}' already registered in ${AGENTS_FILE}`);
  process.exit(0);
}

// Only ever back up a file we are about to change.
if (fs.existsSync(AGENTS_FILE)) {
  fs.copyFileSync(AGENTS_FILE, `${AGENTS_FILE}.bak`);
  console.log(`Backed up existing config to ${AGENTS_FILE}.bak`);
}
config.agents[AGENT_NAME] = wanted;
fs.writeFileSync(AGENTS_FILE, JSON.stringify(config, null, 2) + '\n');
console.log(`${existing ? 'Updated' : 'Registered'} agent '${AGENT_NAME}' in ${AGENTS_FILE}`);
NODE

if [ "${1:-}" = "--setup" ]; then
  exit 0
fi

echo
echo "Starting the desktop build. Pick '$AGENT_NAME' and send any prompt."
echo "Expected: one Assistant message holding both tool rows and the text."
cd "$REPO_DIR"
exec npm run tauri dev
