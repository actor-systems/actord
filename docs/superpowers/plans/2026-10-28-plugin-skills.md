# Plugin skills, templates and eval scaffolds on the new foundation (plan 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude and Codex plugin skills, the plugin's two agents, the `actord init` guidance, and the eval scaffolds teach the toolkit as it is after plans 1–4. A test makes sure their code examples keep compiling against it.

**Architecture:**
- **What stays.** No new skills. Two tests require exactly 7 Claude skills and 2 agents, and the always-on token budget counts every skill description. So each new capability goes into a **reference file** under the skill that uses it:
  - timers and jobs, sources, agent actors and decisions under `implement/references/`;
  - the declaration surface under `design/references/`.
- **The safety net.** A new gate typechecks every fenced code block marked `// actord:check` in the skills and their references against the built toolkit types. This plan writes it first, then marks the old code red. Code examples are what drifted silently before.
- **Codex copies.** A test pins the three hand-copied Codex `workflow.md` variants identical across their copies.

**Tech Stack:**
- Markdown skills: Claude Code plugin skills, and Codex skills.
- TypeScript, with `tsc` for the snippet gate.
- The existing gate harness: `scripts/checks.mjs`, `tests/*.test.mjs` and `node --test`.
- `claude plugin eval` scaffolds, run only by `scripts/eval-suite.sh` and only with the owner's approval.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-sdk-foundation-design.md` §10:
> As the last step: the Claude and Codex plugin skills, the `actord init` templates, the Codex reference templates and the eval scaffolds, all updated to the new foundation.

The release checks (`scripts/codex/distribution.mjs`, `tests/release.test.mjs`) must pass. There is no npm release and no paid eval run without the owner's separate approval.

**What the skills must agree with** (the authority, in this order):
1. the code: `packages/toolkit/src/**`;
2. `docs/wiki/Runtime.md` and `docs/wiki/Limitations.md`;
3. decisions 0016–0022.

**Where this plan sits:** plan 5 of 5. Plans 1–4 are merged, along with #77, #80 and #82. After it, the factory gets its own design, in a separate repository.

## What the survey found (2026-10-28)

Two read-only surveys mapped the plugins against plans 1–4. The headline findings:

- **Every skill and both agents teach the runtime from before plan 1.** None mentions `Lifecycle`, timers, `cron`, job effects, sources, agent actors, decision effects or `actord scorecard`.
- **Code that doesn't compile.** `implement/references/runtime.md:5-27` shows a class without `Lifecycle.install` that forwards `alarm()`. `ActorRuntime` has no `alarm`, so this code doesn't typecheck.
  - Codex `references/workflow.md:9` shows `actorRuntime({ctx, env}, …)` with no `lifecycle`.
- **Wrong rules.**
  - `agents/delivery-auditor.md:15-17` says an await in a handler "blocks every other message". Since #80 and #82, any await that yields fails the delivery.
  - `skills/start/SKILL.md:29` calls briefing-desk "an agent actor". It is model-assisted, and `kind: "agent"` now means a Pi session.
  - `design/references/declaration.md:16` gives an agent `maxTokens`. An agent needs `usd`, `turns` and `wallClock`.
- **Node 22.18.** The setup skills say 22.18 and `actord doctor` accepts it, but `engines` says 22.19.
- **Already current.** The `actord init` starter and both example apps already use the Lifecycle foundation (`src/templates/project.ts`, `Lifecycle.install(this)` in every example actor).
- **Nothing ties eval evidence to a skill hash.** But decision 0010 §6 and `docs/evidence/evals/README.md` say runs that measured a changed plugin are superseded. Runs L and M ($10.00 and $10.05) measured the skills at `9f9701a`.

## Global Constraints

- **The plugin's shape.** Exactly **7** Claude skills (`start`, `setup`, `design`, `implement`, `reliability`, `inspect` and `evolve`) and **2** agents (`boundary-critic` and `delivery-auditor`). `tests/skills.test.mjs:22-25` and `g5.inventory` require it.
- **Skill rules** (`tests/skills.test.mjs`):
  - the name matches its folder;
  - the description is over 80 characters, and the description plus `when_to_use` is at most 1,536;
  - `SKILL.md` is under 500 lines;
  - "Rules that hold for this whole skill" appears in the first 1,500 characters, with a done condition and a stop condition;
  - `allowed-tools` never matches `deploy|secret|publish|curl|wget|npm install|--remote|wrangler`;
  - every `` !`cmd` `` ends in `|| true` and is pre-approved.
- **The token budget.** The always-on budget is the frontmatter descriptions only. It is ~803 tokens today; the target is ≤ 1,000 and the hard limit 1,500 (`scripts/budget.sh`). Don't grow descriptions without need. `budget.sh` rewrites `docs/evidence/plugin-details.txt`, so commit it.
- **The starter.** `CLAUDE.md` stays at 10 lines or fewer (`test/g5.test.ts:32`). The starter verifies with exactly 3 proved claims and 3 steps (`scripts/starter-smoke.sh`). `actord init --adopt` never overwrites a file.
- **Generated files.** The init templates are compiled into the CLI, so any template edit rebuilds the plugin dists (`npm run build -w @actord/toolkit`). The dists are committed on their own, and `g1.dist.fresh` checks them. `plugins/codex/dist/reference-templates.json` is generated from `examples/`: edit the examples, never the JSON.
- **Copied files.** The examples' `CLAUDE.md`, `AGENTS.md`, `.claude/skills/verify/SKILL.md` and `settings.json` are copies of the init templates. Nothing regenerates them, so update them by hand to match.
- **Codex.** `plugins/codex/skills` must pass `prettier --check` (`g1.codex.format`) and `validate-plugin.mjs`. Every relative link must resolve.
- **Eval cases** must keep `tests/evals.test.mjs` green:
  - the case mix (≥6 representative, ≥2 adversarial, ≥2 negative, ≥3 safety, and `safety-deploy-request`);
  - only allow-listed prompt keys;
  - at least 2 graders, with a process grader and a result grader;
  - an evidence grader wherever the prompt asks for `actord verify`;
  - executable scaffolds.
- **What needs the owner.** No model-backed `claude plugin eval` run without the owner's separate approval: each costs about $10–13. No npm release.
- **Facts.** Every fact a skill states must match the code and `docs/wiki/Runtime.md`. When a skill and the code disagree, fix the skill.
  - Handlers may not await I/O (#80, #82): any await that yields to the event loop fails the delivery, `setTimeout(0)` included.
  - Node 22.19.
- **Hygiene.** Never `git stash`. Never commit `.superpowers/`.

## Review Focus

1. **A skill's code example that doesn't compile against the current toolkit.** The snippet gate catches it. Each reference that shows the runtime API carries at least one checked block, and the gate fails if a listed reference has none.
2. **A skill that writes a handler without stating the no-await rule,** or that shows an `await` inside a handler body. The `implement` skill, its reference, the Codex implement skill and `delivery-auditor` each state the rule. A test greps for it in those four files.
3. **Codex copies drifting.** The three `workflow.md` variants are identical across their copies, and a test pins it.
4. **The starter and the examples.** The starter still verifies with exactly 3 proved claims. Both examples still pass `actord verify`. `CLAUDE.md` stays at 10 lines or fewer, and states the no-await rule.
5. **An eval scaffold whose source patch silently does nothing.** `recover-duplicate-notify` patches release-radar with Python `str.replace`. It fails the scaffold when a pattern isn't found, and so does every scaffold that patches.

---

### Task 1: The safety nets (the snippet gate, Codex copies, the Node floor)

**Files:**
- Create: `tests/skill-snippets.test.mjs`
- Modify: `scripts/checks.mjs`. Add gate `g5.skills.snippets` next to `g5.skills.lint` (line 266), running `node --test tests/skill-snippets.test.mjs`.
- Create: `tests/codex-workflows.test.mjs`. Wire it into the same gate, or into `g1.codex.validate`, whichever reads better.
- Modify: `packages/toolkit/src/cli/commands/doctor.ts`, at `:26` (the version check) and `:43` (the fix text), and its tests.
- Modify: the plugin skills' existing `ts` blocks that show runtime API code. Mark them `// actord:check` on their first line, so the gate goes red on the old code. Don't fix them here; Tasks 2–5 do.

**Interfaces:**
- **What the gate checks.** Every fenced block whose first line is `// actord:check` is compiled. That covers ` ```ts ` or ` ```typescript ` blocks in `plugins/claude/skills/**/*.md`, `plugins/claude/agents/*.md` and `plugins/codex/skills/**/*.md`.
- **How each block is compiled.**
  - Each block becomes its own module, `snippet-<file>-<n>.ts`, in a temp project under `os.tmpdir()`.
  - Its `tsconfig` is `strict`, `noEmit`, `module` and `moduleResolution` `bundler`, with the same Workers runtime types the toolkit's own `npm run typecheck` uses.
  - `paths` maps `@actord/toolkit/*` to `packages/toolkit/dist/types/*/index.d.ts`, matching each `exports` entry's `types`. Also map `agents/*` and the agents peers to the repo's `node_modules`.
  - It runs with the repo's `tsc`.
- **Imports between blocks.** A block may import a sibling block of the same file by `./system` when that sibling's first line is `// actord:check system`. Its module is then named `system.ts`, so a handler example can import the declaration it implements.
- **The files that need a checked block.** The test also asserts that each of these files contains at least one checked block:
  - `implement/references/runtime.md`;
  - `implement/references/timers-and-jobs.md`, `sources.md`, `agents.md` and `decisions.md`, created in Task 2;
  - `design/references/declaration.md`;
  - each Codex `references/workflow.md`.

  A file that doesn't exist yet fails the test with "missing".
- **The Codex copies.** `tests/codex-workflows.test.mjs` asserts:
  - the evolve, inspect and setup copies of `workflow.md` are byte-identical;
  - the implement and verify copies are byte-identical;
  - the design copy stands alone.
- **The no-await rule.** `tests/skill-snippets.test.mjs` also asserts that these four files each contain the phrase `handlers may not await` (case-insensitive):
  - `implement/SKILL.md`;
  - `implement/references/runtime.md`;
  - Codex `implement-actor-behavior/SKILL.md`;
  - `agents/delivery-auditor.md`.

  This is Review Focus 2.
- **Node.** `actord doctor` requires Node `>=22.19`, matching `engines`. This supersedes spike 3's note that doctor's own check could stay at 22.18, because the toolkit's `engines` and its Pi peers now require 22.19.

- [ ] **Step 1: Write the snippet test.** Build the toolkit, then run it against `HEAD` with two kinds of blocks marked: the current `runtime.md` class example, and the Codex `workflow.md` `actorRuntime` line.
  - **Expected: RED.** The runtime example fails with `Property 'alarm' does not exist` (or similar). The required-file assertion fails with `missing: implement/references/timers-and-jobs.md` and the other new files.
  - Record the output.
- [ ] **Step 2: Write the Codex-copies test** and run it. It passes today if the copies are identical; record which variants exist.
- [ ] **Step 3: Add the doctor test.** Node 22.18.x is an error with the 22.19 fix line. Implement it.
- [ ] **Step 4: Add the gate** to `scripts/checks.mjs`. Run `node scripts/verify.mjs --only g5.skills.snippets`: it fails (RED is expected until Tasks 2–5).
- [ ] **Step 5: Run.** The toolkit unit suite and typecheck pass, and the build is clean.
- [ ] **Step 6: Commit.**
  - Commit the tests, the gate and the doctor change as `Skill code examples are typechecked; Codex workflow copies are pinned; doctor needs Node 22.19 (plan 5)`.
  - Commit the dists separately.
  - Note in the commit body that `g5.skills.snippets` is red until Task 5.

### Task 2: The `implement` skill and its runtime references

**Files:**
- Modify: `plugins/claude/skills/implement/SKILL.md`.
- Rewrite: `plugins/claude/skills/implement/references/runtime.md`.
- Create, under `plugins/claude/skills/implement/references/`: `timers-and-jobs.md`, `sources.md`, `agents.md` and `decisions.md`.

**What each covers.** Each is checked against the code and Runtime.md, with at least one `// actord:check` example:
- **`runtime.md`.** The actor class:
  - `Lifecycle.install(this)`, `actorRuntime({ ctx, env, lifecycle }, …)` and `receive`, with no `alarm()`. Copy it from `examples/release-radar/src/actors/*.ts` and `src/templates/project.ts`;
  - the handler rules: synchronous work, `ctx.sql`, the allowed storage awaits, and "handlers may not await I/O; use `ctx.effect`", with what fails, how it fails and what the canary is (Runtime.md);
  - the full `ctx` surface: `send`, `effect`, `approve`, `deny`, `after`, `at`, `cancelTimer`, `settleJob`, `cancelJob`, `note`, `acted`, `outcome`, `now`, `sql`, `self` and `key`;
  - `EffectAdapter`, `reconcile` and `reportUsage`, `EffectRejected` and `EffectNotDelivered`;
  - the testing helpers: `settle`, `tick`, `fireTimers`, `expireJobs`, `expireApprovals`, `injectFault`, `overrideEffect`, `overrideEffectBudget` and `captureEvents`.
- **`timers-and-jobs.md`.**
  - Timers: `ctx.after`, `ctx.at`, `ctx.cancelTimer`, and the `@timer` route.
  - Schedules: `every` and `cron`, through `@clock`.
  - Job effects: `kind: "job"`, `deadline`, `probe`, `completes`, `JobAdapter` `start`/`probe`/`cancel`, and `ctx.settleJob`, with honest `in_doubt` (decision 0018).
  - Parking after interruptions.
  - Approval expiry: `expires`, and the `failed` result.
- **`sources.md`.** The `sources` declaration (`webhook({ path, verify: "github", secret, events })`, `@email`), `handleWebhook` and `handleEmail` wiring, `.dev.vars.example`, `send_email`, the source events, and email approvals with `approvalEmail` and `authserv` (decisions 0017 and 0021).
- **`agents.md`.**
  - The declaration: `kind: "agent"`, `harness: pi(...)`, `model`, `instructions`, `effects`/`tools`, `returns`, `budget` (`usd`, `turns` and `wallClock`), and `on` verbs.
  - `agentRuntime` wiring. The optional peers to install.
  - Workspaces: `localOnly` required, `egress: "registry-read"`, `execTimeoutMs`, the `WorkspaceProxy` export, the containers entry, `gitClone` and `gitPushEffect`, and `factoryBranch`.
  - The limits that matter to a builder. Point to Limitations; don't copy it (decisions 0019 and 0022).
- **`decisions.md`.**
  - `kind: "decision"` with `questions` and `mode`, and `kind: "extraction"` with `fields`.
  - `decisionAdapters(system, { ai: env.AI, inputs })`.
  - Records, `ctx.acted` and `ctx.outcome`, shadow mode, and "a decision's result can't approve".
  - `actord scorecard`.
  - Clairic's guessing, and `null_threshold` (decision 0020, spike 7).
- **`SKILL.md`.**
  - Fix `:41-42`, which says "forwards `alarm()`".
  - State the no-await rule in its rules section.
  - Route to each reference by need: "if the actor has a timer or a job, read …".
  - Keep it under 500 lines, and keep the description within budget.

- [ ] **Step 1:** Write `runtime.md` and the four new references, with `// actord:check` examples. Prefer examples lifted from tested code: `test-runtime/src/*.ts`, the examples and the templates.
- [ ] **Step 2:** Run `node --test tests/skill-snippets.test.mjs`. The `implement` files pass; the files left for later tasks still fail.
- [ ] **Step 3:** Update `SKILL.md`. Run `node --test tests/skills.test.mjs` and `bash scripts/budget.sh`: both pass, under budget.
- [ ] **Step 4:** Commit as `implement skill: the Lifecycle class, the no-await rule, and references for timers, jobs, sources, agents and decisions`, with `plugin-details.txt` if `budget.sh` changed it.

### Task 3: The `design` skill and `boundary-critic`

**Files:**
- Modify: `plugins/claude/skills/design/SKILL.md`, `references/declaration.md` and `references/boundaries.md`, and `plugins/claude/agents/boundary-critic.md`.

**The content:**
- **`declaration.md`.**
  - The full `system.ts` surface:
    - senders `@ingress`, `@clock`, `@timer` and `@<source>`;
    - effect fields `kind` (`call`, `job`, `decision` or `extraction`), `deadline`, `probe`, `completes`, `expires`, `publishes`, `input`, per-effect `budget`, and `model`, `questions`, `fields` and `mode`;
    - actor kinds: deterministic, model-assisted, and `agent` with its budget;
    - `sources` and `approvals`.
  - Fix `:16`: an agent's budget is `usd`, `turns` and `wallClock`.
  - Include one `// actord:check system` block showing a small system that uses a timer, a job, a source and a decision.
- **`boundaries.md`.**
  - Lifecycle owns the alarm: there is no "one alarm per instance" row.
  - Add rows for timers and `cron`, job effects, sources as the way external events enter, decision effects, and agent actors.
- **`SKILL.md`.**
  - The full sender list.
  - Offer a decision effect on a deterministic actor as the lighter choice before a model-assisted or agent actor.
  - Tell model-assisted and agent actors apart.
- **`boundary-critic.md`.** The same blind spot: prefer a decision effect, or a job, to a new agent actor where it does the job.

- [ ] **Step 1:** Write the content, and include a typechecking example.
- [ ] **Step 2:** Run `node --test tests/skill-snippets.test.mjs tests/skills.test.mjs` and `bash scripts/budget.sh`. The design files pass.
- [ ] **Step 3:** Commit as `design skill and boundary critic: the full declaration surface after plans 1–4`.

### Task 4: `reliability`, `evolve`, `inspect`, `start`, `setup` and `delivery-auditor`

**Files:**
- Modify:
  - `plugins/claude/skills/reliability/SKILL.md` and `references/fault-matrix.md`;
  - `plugins/claude/skills/evolve/SKILL.md` and `references/compatibility.md`;
  - `plugins/claude/skills/inspect/SKILL.md`;
  - `plugins/claude/skills/start/SKILL.md`;
  - `plugins/claude/skills/setup/SKILL.md`;
  - `plugins/claude/agents/delivery-auditor.md`.

**The content:**
- **`fault-matrix.md`.**
  - Keyed effects: retried, then parked after 5 interruptions.
  - New rows, each with its testing helper:
    - the handler-await canary;
    - timers (fire, cancel, survive a restart);
    - job deadline, probe and cancel;
    - approval expiry;
    - webhook signature, and redelivery dedupe;
    - agent budget exhaustion;
    - a shadow decision never delivered.
  - In `reliability/SKILL.md`, reframe "reentrancy around an await" for the no-await rule.
- **`compatibility.md`.** Add rows for every change `actord diff` now classifies:
  - `agent.*` (`diff.ts:162-178`);
  - `source.*` (`:79-80`, `:216-224`);
  - the new `effect.*` fields (`:203`): `kind`, `deadline`, `probe`, `completes`, `model`, `questions`, `fields` and `mode`.

  Warn that a deploy reaches a busy agent late, and that the scorecard mixes models after a model change.
- **`inspect/SKILL.md`.**
  - Add `actord scorecard` to `allowed-tools` and to the steps.
  - Explain in a trace:
    - how a job was settled;
    - parked effects;
    - `source.*` events;
    - `decision.recorded`, `decision.acted` and `decision.outcome`.
- **`start/SKILL.md`.** briefing-desk is model-assisted, not an agent actor. Mention that agent actors exist, and where to read about them.
- **`setup/SKILL.md`.** Node 22.19.
- **`delivery-auditor.md`.**
  - Replace `:15-17` with the no-await rule: "handlers may not await", what fails, and the canary.
  - Add checks:
    - a job settled in its `completes` handler;
    - a decision's result used to approve;
    - handlers reading `_actors_decisions`;
    - source handlers idempotent on business keys;
    - an abandoned handler's writes.

- [ ] **Step 1:** Write the content.
- [ ] **Step 2:** Run `node --test tests/skills.test.mjs tests/skill-snippets.test.mjs tests/monitor.test.mjs` and `bash scripts/budget.sh`. Everything passes except the Codex files, which are Task 5.
- [ ] **Step 3:** Commit as `reliability, evolve, inspect, start, setup and the delivery auditor: on the current runtime`.

### Task 5: The Codex plugin skills

**Files:**
- Modify: the six `plugins/codex/skills/*/SKILL.md`, and the three `references/workflow.md` variants in all six copies.

**The content:**
- **The Codex `workflow.md`.**
  - The Lifecycle class shape, with `actorRuntime({ ctx, env, lifecycle }, …)` in a `// actord:check` block;
  - the no-await rule;
  - one short paragraph on each of timers and jobs, sources, agent actors and decisions, with a pointer to the docs. Codex has no references directory beyond `workflow.md`.
- **`implement-actor-behavior/SKILL.md`.** Install `Lifecycle`; drop "normal Durable Object classes"; state the no-await rule.
- **`setup-actor-project/SKILL.md`.** Node 22.19.
- **Format.** Run Prettier.

- [ ] **Step 1:** Edit one copy of each variant, then copy it to its siblings.
- [ ] **Step 2:** Run:
  - `node --test tests/codex-workflows.test.mjs tests/skill-snippets.test.mjs`;
  - `npx prettier --check plugins/codex/skills`;
  - `node scripts/codex/validate-plugin.mjs`.

  All pass. `g5.skills.snippets` is now green.
- [ ] **Step 3:** Commit as `Codex skills: the Lifecycle class, the no-await rule, and the plans 1–4 capabilities`.

### Task 6: Starter guidance, the examples' copies and the eval scaffolds

**Files:**
- Modify:
  - `packages/toolkit/src/templates/claude.ts` (`CLAUDE.md` and the verify skill);
  - `packages/toolkit/src/templates/host.ts` (Codex `AGENTS.md`);
  - the examples' copied `CLAUDE.md`, `AGENTS.md`, `.claude/skills/verify/SKILL.md` and `settings.json`, to match.
- Modify: `plugins/claude/evals/recover-duplicate-notify/scaffold.sh`, and any other scaffold that patches source, so a pattern that isn't found fails the scaffold.
- Create three eval cases under `plugins/claude/evals/`, each with `prompt.md`, `graders/`, `case.yaml` and `scaffold.sh` on the starter scaffold:
  - **`add-timer-retry`.** Representative and implement. Add a delayed retry with `ctx.after` and an `@timer` route.
  - **`wire-github-webhook`.** Representative and design-plus-implement. Add a `@github` source, with signature verification, that maps `issues.opened` to a message.
  - **`add-triage-decision`.** Representative and design. Add a Clef-flash decision effect, in shadow mode, with `ctx.outcome` labelling.

  Each gets graders: a process grader (`tool_used` or trace), a result grader (a regex over `system.ts` for the new declaration), and the evidence graders for `actord verify`, following `add-message-handler/`. No agent-actor case: the scaffold can't install the optional Pi peers offline. Say so in the case-list README.

**The content:**
- **The starter's `CLAUDE.md`** gains the no-await rule within its 10 lines. `AGENTS.md` gains it too.
- **The starter's behaviour doesn't change:** exactly 3 proved claims.

- [ ] **Step 1:** Update the templates and the examples' copies. Rebuild.
  - Run `npx vitest run test/g5.test.ts test/templates.test.ts` in `packages/toolkit`, `bash scripts/starter-smoke.sh`, and `actord verify` on both examples. All pass.
- [ ] **Step 2:** Harden the patching scaffolds.
  - Run each case's `scaffold.sh` in a temp directory: all succeed.
  - Run one with a broken pattern, to see it fail.
- [ ] **Step 3:** Add the three cases.
  - Run `node --test tests/evals.test.mjs`: it passes, and the case mix still holds.
  - Run each new scaffold in a temp directory: they succeed.
- [ ] **Step 4:** Commit. The templates and examples go in one commit, the scaffolds and cases in another, and the dists separately.

### Task 7: Eval evidence, docs and verification

**Files:**
- Modify: `docs/evidence/evals/README.md`, `docs/progress.md` and `CONTRIBUTING.md` (the snippet gate, if it describes the gates).
- Create: `docs/decisions/0023-skills-track-the-runtime.md`. It records:
  - no new skills: capabilities go in references (the 7/2 shape, and the token budget);
  - the `// actord:check` snippet gate, and why: the code examples drifted silently through plans 1–4;
  - the Codex copies test;
  - doctor's Node floor;
  - the eval-evidence choice below.
- Modify: `docs/wiki/*` only where it describes the plugin skills.

**The eval evidence — the owner's choice, made before this task runs:**
- **Option A (recommended).**
  1. Apply decision 0010's rule: move runs L and M to `superseded/`, since they measured skills this plan rewrote.
  2. Until a new round, `g5.evals.run`, `g5.evals.host` and `g1.start-session` report **blocked**, not failed, and `npm run verify` still exits 0.
  3. After merge, the owner approves a paid round: two full runs of 15 cases, about $12–13 each, about $25 in all, with a ceiling of $14 a run. The runs restore the gates.
- **Option B.** Keep L and M in place with a README note that they measured the skills at `9f9701a`, as `README:59` did for a small edit. The gates stay green on evidence that no longer measures the plugin.

- [ ] **Step 1:** Write decision 0023, and the docs for the chosen option.
- [ ] **Step 2: Verify from a clean clone.** Clone the final pushed commit into a scratch directory, then run `npm ci`, `npm run build -w @actord/toolkit` and `npm run verify`.
  - Expected: every gate passes or is blocked. Allowed blocks:
    - `g6.mod.typecheck`, on this machine;
    - under option A, the three eval gates.

    Any other blocked gate needs a reason.
  - Copy back `verify-report.json`, `docs/verification-report.md` and the clean-checkout evidence.
- [ ] **Step 3: Commit** as `Verification for plan 5 (plugin skills): <N> pass, <F> fail, <B> blocked`.
