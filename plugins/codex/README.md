# actord for Codex

The Codex adapter shares `packages/toolkit` and the root `examples/` with the Claude plugin (decision
[0014](../../docs/decisions/0014-one-repository.md)). Version 0.2.0, Apache-2.0 under the root
[LICENSE](../../LICENSE) and [NOTICE](../../NOTICE). Product intent lives in [the charter](../../docs/charter.md).

## Install and use

```sh
codex plugin marketplace add actor-systems/actord
codex plugin add actord@actord
codex plugin list --json
```

For a local checkout, run `codex plugin marketplace add /absolute/path/to/actord` instead. The root
`.agents/plugins/marketplace.json` points directly at `./plugins/codex`; there is no filtered adapter build.
Node.js 22.18+, npm, tar, and Codex with plugin CLI support are required (tested CLI 0.164.0).
Start a fresh Codex chat after installation. Invoke `setup-actor-project`, `design-actor-system`,
`implement-actor-behavior`, `verify-actor-reliability`, `inspect-actor-system`, or `evolve-actor-system`.

```sh
node /absolute/path/to/actord/plugins/codex/bin/actord.js init /tmp/my-app --template release-radar --json
# Other choices: --template briefing-desk, or omit --template for the two-actor starter.
cd /tmp/my-app
npm install
npx actord graph --write
npx actord graph --format mermaid
npx actord verify --json
```

Read the actual verdict in `.actord/evidence.json`; exit 0 can accompany a blocked verification.
Unknown traces exit 1; usage errors exit 2. `diff` exits 0 on successful analysis even for breaking changes.

## Adapter and build

`bin/actord.js` delegates to the nearest installed `@actord/toolkit` pin, falling back to `dist/actord.mjs`.
The launcher sets `ACTORD_HOST=codex`. The shared host profile writes `AGENTS.md` and
`.agents/skills/verify/SKILL.md`; adoption preserves existing user guidance. Projects retain independent
pins and remain usable without the plugin.

Run `npm ci` and `npm run build -w @actord/toolkit` at the repository root. The same build writes both
plugins' CLI, VERSION and toolkit tarball. Root example sources are built into
`plugins/codex/dist/reference-templates.json`, so installed/cached Codex plugins can scaffold without the
repository. The template data ships only with Codex; neither toolkit tarball contains it. No vendor directory,
provenance pins, sync script, or second copy of the example source is maintained here.

Tests live in `tests/codex-*.test.mjs`; validation, installation and standalone consumer scripts live in
`scripts/codex/`. Root `npm run verify`, clean-checkout, container and CI lanes cover both plugins.
The Codex tests use disposable configuration, local workerd and fixture effects; they do not invoke models.
New model-backed evaluations need owner approval. Historical Claude results do not establish Codex skill
performance. Desktop onboarding and production integrations remain unverified for this adapter.

## Update and uninstall

To update, remove the plugin, refresh its marketplace source, and install it again:

```sh
codex plugin remove actord@actord
codex plugin marketplace remove actord
codex plugin marketplace add actor-systems/actord
codex plugin add actord@actord
```

For local development, rebuild first and re-add the absolute checkout path. Start a fresh chat to load
the refreshed skills. This changes the plugin bundle, not existing projects' toolkit pins.

To uninstall:

```sh
codex plugin remove actord@actord
codex plugin marketplace remove actord
```

The adapter needs no hooks, MCP server or credentials. It neither installs nor configures Claude's Room,
hooks or critics. Native bindings retain authority; routes are correctness contracts. External exactly-once
effects, cross-actor transactions, unrestricted generated-code isolation and production trace collection
are not guaranteed. Deployments and real external writes need explicit authorization.
