# 0001 — Guardrails for the implementing agent

- **Date:** 2026-10-24 · **Gate:** pre-G0 · **Status:** accepted · **Reversibility:** easy (edit `.claude/settings.json`)

## Decision
Commit `.claude/settings.json` with `deny` rules for deployment, secrets, remote writes, package
publishing, tag pushes and force pushes, plus `ask` rules for plain `git push`, PR/issue creation and
`claude plugin eval` (which spends model usage).

## Verified platform behavior (Claude Code 2.1.310, docs read 2026-10-24)
- Deny rules block in every permission mode, including `bypassPermissions` (permission-modes doc).
- Bash rules match command text; deny rules apply to every subcommand of a compound command and match
  past leading env-var assignments. They do **not** match other spellings (`/usr/bin/x`, `sh -c`), so
  these rules are a tripwire, not a security boundary. Cloudflare token scopes are the boundary.
- Rules starting with `*` are permitted in deny/ask; the startup warning for a leading wildcard applies
  only to allow rules. Leading `*` lets one rule cover `npx`, `pnpm exec`, `bunx`, and
  `./node_modules/.bin/` runners.
- Tool-name globs work in deny rules and remove matching MCP tools from context.
- `claude plugin eval` publishes its HTML report to claude.ai by default, so every run must pass
  `--no-publish`. `--publish-report` is denied.

## Evidence (commands run in this session, each refused by the permission engine)
- `echo npx wrangler deploy --dry-run` → denied (`*wrangler deploy*`)
- `echo pnpm publish` → denied (`*npm publish*` matches as a substring)
- `git push --force origin main` → denied
- `git -C . push --tags` → denied
- `FOO=1 echo ok; echo wrangler secret put X` → denied (second subcommand)
- `git push origin actors--v0.1.0` → denied (plugin tag format `{name}--v{version}`)
- Control: `git status --short` → ran.
- The Cloudflare Developer Platform MCP `*_create/_delete/_update/_edit`, `d1_database_query`, and
  `mcp__plugin_cloudflare_cloudflare__execute` tools were removed from the session on load.
- A first probe, `echo git push --force …`, ran because `git*` rules are anchored at the start of the
  command. That was a flaw in the probe, not the rule.

## Known false positives (accepted)
Text matching is coarse: a `git commit -m` message containing `wrangler deploy`, or a `grep` for it,
is refused. Use `git commit -F <file>` or the Grep tool instead.

## Alternatives rejected
- PreToolUse hook parser: more precise, but it's custom code and still bypassable. Rules are the
  documented mechanism.
- `disableBypassPermissionsMode`: would break the owner's working mode. Deny rules already hold there.
