# Codex plugin migration — decision 0014

Implementation commit: `9e54f06`, branch `codex-plugin`, based on `main` at `74d3d5f`.
The owner reviews and merges; version 0.2.0 has not been tagged by this migration.

## Result

- `plugins/codex/` contains the portable Apache-2.0 manifest, six skills, launcher, template adapter,
  README and generated distribution. Its root marketplace entry points directly at that directory.
- One `packages/toolkit/build.mjs` writes the same CLI, VERSION and toolkit archive into both plugins.
  `g1.dist.fresh` checks all six artifacts, Codex’s template data and the existing generated effect-pattern table.
- Root `examples/` are the only source copies of the reference apps. Their filtered source data is
  written to `plugins/codex/dist/reference-templates.json` during the shared build, so a separately cached plugin can create
  either example without access to a checkout. The build excludes dependencies, session/runtime state,
  secrets, generated environment declarations and Claude guidance. No maintained template copy,
  vendor/core, provenance pin or sync command exists in the Codex adapter.
- Repository-level Codex validation, installation, distribution and consumer scripts are in
  `scripts/codex/`; adapter regressions are in `tests/codex-adapter.test.mjs`.
- Root LICENSE and NOTICE apply throughout; each toolkit archive includes both. No separate MIT
  adapter license ships. Decision 0012 records that its synchronization process is superseded by 0014.
- Claude skills, hooks, the Room and launcher source are unchanged. Its generated toolkit archive was
  rebuilt with legal notices only; reference template data ships exclusively in Codex’s distribution,
  outside both toolkit archives. The previous repository was not modified.

## Executed verification

Root `npm run verify`: **61 pass, 0 fail, 0 blocked, 0 skipped; G0–G7 all passed**.
Machine report: [verify-report.json](../../verify-report.json).
Human report: [verification-report.md](../verification-report.md).

Codex checks include portable schema/path validation, distribution safety and template freshness,
formatting, ten adapter regressions, direct-marketplace install and uninstall in disposable Codex
configuration, and a standalone copy of the shipping directory that installs and verifies the starter
and both reference apps in workerd. The consumer executes 32 steps, including negative compiler and
unknown-format probes, trace inspection and semantic diff.

The clean-checkout lane cloned the implementation commit, installed the lockfile, reproduced both
plugin distributions byte-for-byte and passed every executed check (59 pass; the two recursive lanes
are intentionally skipped inside that clone). The Linux container lane installed and uninstalled both
plugins and passed their local starter/consumer verification without host credentials.

Evidence:
- [Codex install/uninstall](codex-install.json)
- [Codex standalone consumer](codex-clean-install.json)
- [Clean-checkout report](clean-checkout-verify-report.json)
- [Container transcript](container-install.txt)

## Limits and authorization

No new model-backed evaluation ran. Existing evaluation and Room acceptance gates read the repository's
recorded Claude evidence; they do not establish Codex model behavior or desktop onboarding. Those Codex
checks remain unverified and require separate owner approval before a model-backed run. CI configuration
now installs Codex and covers both distributions; no remote CI run was dispatched.

No production credentials, publishing, push, deployment, merge, or tag was performed. All plugin
installation tests used disposable profiles; existing projects and normal host configuration were unchanged.
