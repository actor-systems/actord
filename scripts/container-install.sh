#!/usr/bin/env bash
# Clean-container install: a fresh Linux container (node:24-bookworm, already local) with nothing but a
# clone of this repository's HEAD. It installs Claude Code from npm, adds this repository as a marketplace,
# installs the plugin, creates a starter project with the installed plugin's `actord init`, verifies it in
# workerd, and uninstalls. Network: the npm registry only. No credentials, no Claude login, no model calls.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="${ACTORD_CONTAINER_IMAGE:-node:24-bookworm}"
claude_version="$(claude --version | awk '{print $1}')"
codex_version="$(codex --version | awk '{print $2}')"
out="${1:-$root/docs/evidence/container-install.txt}"

docker image inspect "$image" >/dev/null 2>&1 || { echo "blocked: image $image isn't available locally (pulling it needs owner approval)"; exit 4; }

docker run --rm -v "$root:/src:ro" -e CLAUDE_VERSION="$claude_version" -e CODEX_VERSION="$codex_version" -e DISABLE_TELEMETRY=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$image" bash -euo pipefail -c '
step() { printf "%s\n" "== $*"; }
step "container: $(uname -sm), node $(node --version), npm $(npm --version)"
git config --global --add safe.directory "*"
git clone -q /src /work
cd /work
step "repository at $(git log --oneline -1)"
step "install Claude Code $CLAUDE_VERSION from npm"
npm install -g --silent "@anthropic-ai/claude-code@$CLAUDE_VERSION" >/dev/null
claude --version
step "marketplace add + install"
claude plugin marketplace add /work
claude plugin install actord@actord
claude plugin list --json | node -e "const l=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); const p=l.find(x=>x.id===\"actord@actord\"); if(!p||!p.enabled) process.exit(1); console.log(p.id, p.version, \"enabled\")"
claude plugin details actord@actord | sed -n "1,12p"
launcher=/work/plugins/claude/bin/actord
step "launcher and doctor (no project, no credentials)"
"$launcher" --version
cd /tmp && "$launcher" doctor || true
step "starter project from the installed plugin"
"$launcher" init /tmp/starter --name "Container App" --json | node -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); console.log(d.mode, d.created.length, \"files\")"
cd /tmp/starter
npm install --silent --no-audit --no-fund >/dev/null 2>&1
step "verify in workerd"
"$launcher" verify
node -e "const e=JSON.parse(require(\"fs\").readFileSync(\".actord/evidence.json\",\"utf8\")); if(e.verdict!==\"pass\") process.exit(1); console.log(\"evidence verdict\", e.verdict, e.summary)"
"$launcher" room | head -6
step "uninstall"
claude plugin uninstall actord@actord
claude plugin marketplace remove actord
claude plugin list --json | node -e "const l=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); if(l.some(x=>x.id===\"actord@actord\")) process.exit(1); console.log(\"not installed\")"
step "Codex install and standalone consumer verification (no credentials)"
npm install -g --silent "@openai/codex@$CODEX_VERSION" >/dev/null
cd /work
npm ci --silent --no-audit --no-fund
node scripts/codex/distribution.mjs
node scripts/codex/install-test.mjs
node scripts/codex/clean-install.mjs --online
echo "container-install: ok (both plugins)"
' 2>&1 | tee "$out"
