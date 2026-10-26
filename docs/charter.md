# Actor-Native Cloudflare Toolkit
## Founding Charter and v0.1 Delivery Contract — Claude Code Edition

**Status:** Founding document · October 24, 2026 · adapted from the Codex charter of the same date  
**Working names:** “Actor-Native Cloudflare Toolkit” (project), `actord` (plugin and CLI), “the Room” (in-session view). Names are provisional.  
**Primary implementation target:** Claude Code, developing the first working release of a Claude Code plugin.  
**Platform baseline:** Claude Code documentation as of October 2026 (mods require terminal v2.1.287+; `claude plugin eval` requires v2.1.269+). Re-verify everything at G0.

### 0. What this edition changes

The Codex charter treated the coding agent as a text-in, text-out Director and the plugin as instructions plus a CLI. Claude Code changes three things, and this edition is built around them:

1. **A plugin can ship executable surface area**, not just instructions: a CLI placed on `PATH`, subagents with isolated context, background monitors, scripted multi-agent workflows, and *mods*, which are TypeScript handlers that run inside Claude Code, draw panes, and can hold a tool call until the user decides.
2. **Plugin evaluation is first-class.** `claude plugin eval` runs each case in an isolated session with and without the plugin and reports the difference; `claude plugin test` exercises mods with no session, sign-in, or network.
3. **Guardrails can be enforced, not just requested,** through Claude Code permission rules.

The product contract is unchanged: same mission, same convictions, same reference applications, same honesty about guarantees. What changes is that the programming experience itself becomes legible. Appendix A maps every Codex-specific provision to its replacement.

### 1. Mission

Build an open-source, Claude Code–native development toolkit for designing, implementing, testing, deploying, inspecting, and safely evolving **small systems of communicating, stateful actors on Cloudflare**. It should make headless, persistent, event-driven applications as understandable and approachable as Rails made conventional web applications.

The initial deliverable is a **real installable Claude Code plugin**, distributed through its own marketplace and supported by Agent Skills, two critic subagents, a companion CLI the plugin puts on `PATH`, an in-session view built as a mod, executable examples, and verification infrastructure. Existing Claude Code is the first “Director”: we improve its competence at this class of software rather than build another coding agent.

The guiding promise is not “generate apps from prompts.” It is **turn intent into an explicit, inspectable system; keep that system understandable as it runs; change it without silently violating its contracts**.

Claude Code makes a second promise possible: **the system should be visible where it is being built.** While Claude designs and changes actors, the developer can watch topology, mailboxes, and causal traces beside the transcript, rendered from the same deterministic evidence the tests use.

This is first an engineering exploration and public demonstration of a new programming experience, not an immediate SaaS monetization effort. Favor technical credibility, clarity, developer usefulness, and open-source adoption over speculative platform breadth.

### 2. Convictions

1. **The actor is the runtime unit of meaning.** Give independent stateful entities stable identities, private state, message interfaces, and explicit boundaries. Model a *society* of cooperating actors, not one giant autonomous loop.
2. **Messages make systems legible.** Communication should be explicit, typed, attributable, and causally traceable. A developer should be able to answer *what happened, why, and what happened next* without reverse-engineering log lines.
3. **The architecture should be explicit.** Source describes actors, contracts, routes, capabilities, and failure policies. Cloudflare resource configuration should be derived where feasible, not treated as the conceptual design.
4. **Convention over configuration.** Offer one excellent default architecture for this category of application, with deliberate escape hatches to native Cloudflare APIs. Avoid hiding consistency or durability tradeoffs behind misleading universal abstractions.
5. **Programs before agents.** An actor may be deterministic code, bounded model-assisted code, or a model-driven agent. Use AI only where interpretation and judgment actually justify it. A fixed control flow that calls a model is not deterministic in its output.
6. **The compiler and tests, not the model, establish guarantees.** Coding agents propose designs and changes; executable checks independently validate contracts and observed behavior. Never equate an AI explanation, an AI critique, or an AI goal-evaluator's verdict with evidence.
7. **Failures are normal; recovery is designed.** Retries, duplicate delivery, interruption, backpressure, reentrancy, and uncertain external effects are first-class concerns.
8. **Change is more valuable than scaffolding.** A first deploy is the demo; the ability to understand and safely modify a live system is the long-term differentiator.
9. **Use the platforms instead of rebuilding them.** Cloudflare Workers, Durable Objects, the Agents SDK, Workflows, Queues, and native storage already solve important runtime problems. Claude Code's skills, subagents, permission rules, evals, and mods already solve the agent-side ones. We supply the missing conventions and application-level checks.
10. **Earn every abstraction.** Each feature must improve an executable reference application or enforce a necessary invariant. Favor a small, complete tool over an unfinished platform. This applies to plugin components too: each one is used only where it does something the others cannot.
11. **Deterministic machinery, visible judgment.** The toolkit's own machinery (CLI, hooks, mod, monitor) is ordinary deterministic code that never calls a model and never approves an action. Judgment lives in skills and subagents, where it shows in the transcript and can be measured by evals. A guard that asks a model is not a guard.
12. **One model, many views.** The normalized system model and the structured event log are the only sources of truth. The CLI, the Room, the monitor, the skills, the hooks, and the eval graders are all views of them. No view computes its own answer.

### 3. Intended applications and boundaries

Target personal and small-team **computational infrastructure for knowledge work**: monitors, coordinators, research pipelines, triage systems, assistants, scheduled information processing, and other primarily headless applications. They may have chat or operational UIs but need not have a conventional frontend.

The first users are experienced developers using Claude Code (terminal, the Desktop app's Code tab, or the VS Code extension) and Cloudflare. The first deployment target is Cloudflare, not a portable multi-cloud actor runtime. Personal responsibilities, cases, and attention policies remain promising *application-level* concepts for future products; they are **not required runtime primitives in v0.1**.

Where the plugin's parts run, per current documentation:

| Where Claude Code runs | Skills, subagents, CLI | Hooks and the Room's effect guard | The Room's pane | Monitor |
| --- | --- | --- | --- | --- |
| Terminal, Desktop Code tab, VS Code | Yes | Yes | Yes (Desktop can draw SVG; VS Code needs extension 2.1.299+) | Interactive sessions only |
| `claude -p`, Agent SDK, eval runs | Yes | Hooks run; nobody can answer the guard, so it refuses | No | No |
| claude.ai, Cowork | Not supported: plugins with a top-level `bin/` aren't installed there | — | — | — |

**Explicit non-goals for v0.1:** a new actor scheduler, a general-purpose compiler or programming language, a visual workflow editor, an autonomous resident Director, a production multi-tenant service, an orchestration daemon, a hosted monitoring service, generalized session types/model checking, arbitrary untrusted-code hosting, universal wrappers for D1/R2/KV, or a full replacement for Wrangler/Void. Claude Code–specific non-goals: an MCP server or mod-registered tools that merely wrap the CLI; model calls from the mod or hooks; prompt- or agent-type hooks; panes that open, or prompts that submit, without a user action; a mod that approves tool calls or restyles Claude Code beyond the Room; output styles, themes, or a language server of our own; channels that push deployed-system events into sessions; claude.ai/Cowork support; CLI install hints (which require an official-marketplace listing).

### 4. Programming model: firm initial recommendations

**TypeScript is the authoring language.** An application has one discoverable, typed **system declaration** plus normal TypeScript modules for messages, actor behaviors, and tests. Avoid a second hand-maintained YAML representation. The toolkit may derive a normalized, serializable architecture manifest for graphing, validation, diffs, and agent inspection. The CLI, the Room, and generated projects all share the one language.

**Make the compiler the first critic.** Shape the system declaration so that undeclared routes, mismatched payloads, and missing handlers are TypeScript errors wherever the type system can express them. With a TypeScript code-intelligence plugin installed, Claude Code receives compiler diagnostics after each edit, so contract violations reach the agent at edit time, not review time. `actord check` covers what types cannot express.

**Actors are native runtime components, not simulated workers.** For the first version, favor native Durable Object classes that install the Agents SDK's `Lifecycle`; actord runs as one capability on it, so SDK capabilities such as harnesses can share the object. Do not require all actors to inherit from a custom universal `ActorHost`. Lightweight helpers, generated types, and conventions may wrap native APIs; native behavior remains accessible.

**Actor boundaries must be justified.** Give an entity its own actor when it benefits from distinct persistent identity, state ownership, lifecycle, concurrency/failure isolation, scheduling, or permissions. Otherwise use an ordinary function, tool, or module. The design skill, backed by the boundary-critic subagent, should actively challenge needless agent/actor proliferation.

**Messages are explicit contracts.** Define names, versions, payload schemas, sender/receiver identities, allowed routes, correlation/causation metadata, and failure outcomes. Default to asynchronous communication; make request/reply an explicit pattern, not an invisible synchronous assumption. Provide compile-time guidance and validate untrusted inputs at runtime.

**Delivery semantics must be honest.** State exactly what the chosen transport guarantees. Where retries occur, assume duplicates. Idempotency is required for handlers with effects. An internal outbox is not proof of exactly-once external effects. Expose ambiguous outcomes as *in doubt* when the destination has no reliable idempotency or reconciliation mechanism. Do not promise global ordering or atomic cross-actor transactions.

**State has an owner.** An actor's authoritative state normally lives in its Durable Object SQLite storage. Durable execution and scheduling use existing Cloudflare facilities when appropriate. Use D1 for genuinely shared relational/read-oriented needs, R2 for objects and archives, and KV for appropriate distributed lookup/cache cases; never imply they have interchangeable consistency semantics.

**One message at a time does not mean blocking control events for an entire model call.** Preserve actor isolation while respecting reentrancy at external `await` points. Long-running work must allow deliberate handling of cancellation, stale results, retries, and control messages. The toolkit must teach and test these boundaries rather than promise that a single thread eliminates races.

**Capabilities are enforceable authority, not diagram decorations.** A declared route is a correctness contract; it is not by itself a security boundary if arbitrary code retains more powerful bindings. Respect native Worker bindings, isolate untrusted/generated code before running it, and require explicit approval for real external writes and deployments.

**Infrastructure is a derived concern, not magic.** Start with supported Cloudflare tooling. G0 compares Wrangler, Cloudflare's `cf` CLI (beta), and Void against the same reference app. Do not make Void a mandatory dependency or write a generic deployment adapter in v0.1. The application model must remain intelligible without any of them.

### 5. Expected developer experience

A developer installs the plugin from its marketplace, from the shell or inside a session:

```
claude plugin marketplace add <org>/<repo>
claude plugin install actord@<marketplace>
```

Recommended companions, not dependencies: Cloudflare's official plugin (`cloudflare@cloudflare`, platform skills and MCP servers) and a TypeScript code-intelligence plugin. The developer then asks Claude Code:

> “Design a release-monitoring system that polls a few feeds, stores what it has seen, asks a second actor to classify significant changes, and notifies me only about new findings.”

Claude should select the relevant skills, have the boundary critic challenge the proposed actors, explain the surviving boundaries and Cloudflare primitives, generate a small conventional project, run local tests, and present the system's *logical* architecture and traceability. Running `/actord-room` opens the Room beside the transcript: the topology, mailboxes filling as tests run, and a causal trace for any selected message. Claude must identify uncertain assumptions and seek approval before real credential use, external effects, or deployment.

A second request, “Add a scheduled digest without breaking the running monitor,” should produce an architectural and code diff (the Room highlights the added actor and routes against the last commit), compatibility/risk analysis, relevant tests, and a deploy plan, not a deploy. If the developer then asks Claude to deploy, the Room's effect guard holds the command and shows the plan, and the project's permission rules prompt again. **Do not imply the runtime can automatically undo external actions.**

A generated project should be self-describing to people, to Claude Code, and to CI, **with or without the plugin installed**. Initial convention (adjust if an executable spike demonstrates a better shape):

- `system.ts`: actor identities, allowed message relationships, declared policies and resource needs.
- `src/actors/`: native actor implementations and local behavior.
- `src/messages/`: versioned runtime-validated contracts.
- `src/`: normal services/functions; not everything is an actor.
- `tests/`: behavior, integration, and fault tests.
- Generated architecture metadata: deterministic, inspectable, clearly marked as derived.
- `package.json`: pins the `actord` CLI as a devDependency so CI and Claude run the same version.
- `.claude/skills/verify/SKILL.md`: a project verify recipe that runs `npm run verify` (which calls `actord verify`). Claude Code's commit instructions tell Claude to run a project skill named `verify` before each commit, so the evidence habit survives in sessions that lack the plugin.
- `.claude/settings.json`: `ask` permission rules for deployment and remote-write commands, generated from the same pattern table as the Room's effect guard. Created only when absent; otherwise the rules are printed as a suggestion.
- `CLAUDE.md` (optional): at most about ten lines saying where the declaration lives and which command establishes what. Never a design treatise.

**Definition of done — project experience:** A fresh sample project can be understood from its declaration, typechecked, locally executed, tested, graphed, and inspected without reading hidden plugin internals. Running generation twice with unchanged inputs does not create conflicting configuration or duplicate resources, and never overwrites existing `.claude/` files. In a Claude Code session without the plugin, the pinned CLI, the project verify skill, and the permission rules still work.

### 6. Claude Code plugin: package and components

Use the current Claude Code plugin format, validated by `claude plugin validate --strict` against the installed version, not an invented manifest schema. Keep the shipped plugin in its own directory so that what is tested is exactly what ships.

```
repo/
├── .claude-plugin/marketplace.json   one entry: { "name": "actord", "source": "./plugin" }
├── .claude/settings.json             guardrails for the implementing agent (§11)
├── plugin/                           the shipped plugin and the unit under test
│   ├── .claude-plugin/plugin.json
│   ├── skills/<name>/SKILL.md        seven skills, each with references/ and templates/ as needed
│   ├── agents/                       boundary-critic.md, delivery-auditor.md
│   ├── bin/actord                    launcher placed on PATH while the plugin is enabled
│   ├── dist/                         single-file bundled CLI, built from packages/cli
│   ├── hooks/                        hooks.json (command hooks and the mod module entry), room.ts
│   ├── monitors/monitors.json
│   ├── workflows/design-review.js    optional (G5 decides)
│   ├── types/index.d.ts              mod state declarations
│   ├── tests/                        claude plugin test suites for the mod
│   └── evals/                        claude plugin eval suite
├── packages/cli/                     TypeScript source of the CLI; npm-publishable
├── packages/runtime/                 minimal helpers (envelope types, validation, causality fields), only if earned
├── examples/release-radar/  examples/briefing-desk/
├── fixtures/valid/  fixtures/negative/
└── docs/decisions/
```

Each component has one job:

| Component | Job in this toolkit | Why this component and not another | Status |
| --- | --- | --- | --- |
| Skills (7) | Workflows and actor conventions | Progressive disclosure; invocable by Claude or the user | Core |
| Subagents (2) | Independent critique of designs and handlers | Isolated context keeps the critique independent of the author's reasoning | Core |
| `bin/actord` | Deterministic machine interface | On `PATH` while enabled; no install step | Core |
| Command hooks | Edit-time contract feedback; opt-in evidence gate | Cheap, deterministic, no model context cost unless they report | Check-on-edit default on; gate opt-in |
| Mod: the Room | Human-facing view and effect guard | Only a mod can draw a pane or hold a tool call for a decision | First-class but optional |
| Monitor | Notable runtime faults reach Claude during local work | Background process whose lines arrive as notifications | Optional |
| Workflow | Multi-critic design review | The script, not the conversation, holds the plan | Optional, user-invoked |
| `userConfig` | Non-secret preferences | Users never edit settings files by hand | — |
| MCP server, LSP server, output styles, themes, `settings.agent` | Not used in v0.1 | No job the components above don't already do | — |

**Skills.** Seven skills, namespaced as `/actord:<name>` (names provisional; the namespace makes the old `-actor-system` suffixes redundant):

| Skill | Was | Purpose | Invocation and scoping | Observable completion condition |
| --- | --- | --- | --- | --- |
| `start` | onboarding | Explain the toolkit, run `actord doctor`, point to the reference apps. | Narrow description; writes no files. | Doctor output shown with actionable fixes; one next step offered. |
| `setup` | `setup-actor-project` | Install prerequisites, choose native Cloudflare tooling, scaffold and explain an application. | Writes only to an empty or disposable directory unless the user confirms. | New project passes install, typecheck, local start, and a first test; verify skill and permission rules present. |
| `design` | `design-actor-system` | Turn intent into a minimal topology and justify actor/function/Workflow/Queue choices. | Invokes `boundary-critic`; no `paths` scoping, since it runs before files exist. | Typed declaration, route map, explicit assumptions, rejected actors, and each critic objection with its resolution. |
| `implement` | `implement-actor-behavior` | Add messages, handlers, state ownership, scheduled behavior, and bounded agent integration. | `paths` scoped to declaration, actor, and message files; injects `actord check --json`. | Code builds; valid messages reach only declared handlers; malformed/unauthorized messages fail clearly. |
| `reliability` | `verify-actor-reliability` | Exercise concurrency, duplicate delivery, restart, retry, and effect boundaries. | Invokes `delivery-auditor`; starts the monitor. | Fault tests demonstrate specific guarantees; report classifies each as proved locally, stub only, or not guaranteed. |
| `inspect` | `inspect-actor-system` | Answer why a message or action occurred using graph, structured events, and platform traces. | Injects `actord graph --json`; starts the monitor. | Known event ID returns its path, outcome, and evidence; unknown IDs report unknown; production history is never invented. |
| `evolve` | `evolve-actor-system` | Safely add/remove/revise actors, message contracts, capabilities, and behavior. | Injects `actord diff --json`; invokes both critics. | Semantic diff, passing compatibility checks and tests, irreversible or approval-required operations flagged, and a deploy plan instead of a deploy. |

Skill authoring rules:

- Each skill has **a narrowly triggered description** (key use case first; description plus `when_to_use` under the 1,536-character listing cap), a concise `SKILL.md` (well under 500 lines), progressive-disclosure references, explicit tool prerequisites, expected outputs, and failure/stop conditions. Put the rules that must survive compaction near the top: after compaction Claude Code keeps only the start of each invoked skill.
- Use **dynamic context injection** to start `implement`, `inspect`, and `evolve` from current evidence rather than recollection, for example `` !`actord graph --json || true` ``. A failing injected command aborts the whole invocation, hence `|| true`. Pre-approve exactly the injected read-only commands with `allowed-tools`, because unapproved injected commands abort outside auto mode.
- `allowed-tools` never names deploy, secret, remote-write, publish, or network commands.
- Platform detail belongs to Cloudflare's own skills and docs (`durable-objects`, `agents-sdk`, `wrangler`, and `llms.txt` indexes). Our skills hold only actor conventions and point there for the rest. Where our advice deliberately differs, the skill says why.
- Knowledge stays in plain Markdown that follows the Agent Skills standard; Claude Code–only frontmatter is welcome, since this edition embraces Claude Code.
- No always-on instructions beyond skill and agent descriptions. A plugin-root `CLAUDE.md` isn't loaded anyway. Measure the always-on cost with `claude plugin details actord`: target 1,000 tokens or less, and fail verification above 1,500.
- Prioritize the user's instructions and the task over generic skill advice. Supply scripts and templates where repeatability matters.

**Subagents.** Both critics have read-only tools and cannot edit; an objection is a hypothesis until an executable check settles it.

- `boundary-critic` argues for fewer actors. For each proposed actor it names which justification (identity, state ownership, lifecycle, isolation, scheduling, permissions) holds or fails, and proposes the check or test that would settle any disagreement. Invoked by `design` and `evolve`.
- `delivery-auditor` reviews handlers and effects for idempotency, duplicate handling, reentrancy at `await` points, in-doubt honesty, and over-claimed guarantees, and proposes the fault tests that would expose each problem. Invoked by `implement`, `reliability`, and `evolve`.

Plugin agents ignore `hooks`, `mcpServers`, and `permissionMode` frontmatter; that suits critics. Pin their models only if evals show a difference.

**Companion CLI on `PATH`.** `bin/actord` is a thin launcher. It prefers a project's pinned CLI (`node_modules/.bin/actord`) and reports a version mismatch through `actord doctor`; otherwise it runs the bundled single-file build in `dist/`, which has no runtime dependencies. The same package is publishable to npm for use outside Claude Code (publishing requires authorization). Caches go in `${CLAUDE_PLUGIN_DATA}`, never in the plugin root, which changes on every update.

**Hooks.** Command hooks only; no prompt or agent hooks. Plugin hooks fire in every session where the plugin is enabled, so each must exit within milliseconds outside an actor project.

- *Check on edit* (`PostToolUse` on Write and Edit; the script filters to the declaration, actor, and message files): runs `actord check --changed --format=brief` within a two-second budget. On hard errors it returns the diagnostics to Claude as context; it never blocks the edit, says nothing when clean, and skips with one log line on timeout. Controlled by `userConfig.check_on_edit` (default true).
- *Evidence gate* (`Stop`): opt-in through `userConfig.strict_evidence` (default false). If actor files changed since the last passing check recorded under the project's `.actord/`, it blocks the stop once with the reason “run `actord check` and the affected tests before reporting.” It never blocks twice in a turn.

**The Room (mod).** The Room is a mod, TypeScript handlers that run inside Claude Code, with exactly two jobs.

1. *A view.* `/actord-room` opens a pane with four tabs, each rendered from CLI JSON obtained with `$.process.run` or `$.process.spawn`; the mod computes nothing itself.
   - **Topology:** actors, routes, and capability edges, with additions and removals highlighted against the last commit (`actord diff --json`). Desktop draws SVG; the terminal draws text.
   - **Mailboxes:** per-actor message lists from `actord events --follow`; selecting a message shows its causal path (`actord trace <id> --json`), including *unknown* where coverage ends.
   - **Contracts:** message names, versions, routes, and the last `actord check` result.
   - **Evidence:** the latest `actord verify` report, split into proved locally, stub only, not guaranteed, and blocked.
   In an actor project, one status line (`$.ui.status`) summarizes the state, for example `4 actors · 7 routes · check ✓`.
2. *An effect guard.* A `tool.call` hook on Bash matches deployment and remote-write commands from the shared pattern table, holds the call with `$.ui.ask`, and shows the semantic diff and deploy plan. The default answer is Refuse. A `.catch` handler makes any failure refuse. Where nobody can answer (`claude -p`, the Agent SDK, eval runs), the call is refused with an instruction to ask the user. On approval the hook calls `next(e)`, so Claude Code's own permission check still runs; the mod never approves anything itself.

The guard is a convenience, not a security boundary: pattern matching misses some spellings, mods are not sandboxed, and other code can reach the same APIs. The enforceable layers are Claude Code permission rules and Cloudflare token scopes, and the README says so plainly.

Mod constraints: each hook stays within Claude Code's ten-second limit, so heavy work belongs to the CLI. The mod's call surface stays minimal and reviewable through the `hooks:` and `calls:` lines of `claude plugin validate`: processes for `actord` only, file reads under `.actord/`, its own store, the UI, and command registration. It never uses `$.model`, `$.http`, `$.prompt.submit`, `$.session.send`, or `tool.check`. Panes open only on a user command. Pane state lives in `$.state` (declared in `types/index.d.ts`); `$.store` holds only user preferences. Command registration handles name collisions. With mods turned off (`disableAllHooks`, an older Claude Code, a WSL session), every capability remains available through CLI text output. Optional stretch: redraw `actord trace` results in the transcript as a causal tree through the `ToolResult` render site.

**Monitor.** `actor-events` runs `actord events --follow --notable`, printing one line per notable event (rejected or unauthorized message, handler crash, exhausted retry, in-doubt effect, unknown route), never one per message. It starts the first time `inspect` or `reliability` runs (`when: on-skill-invoke:…`). Monitors run only in interactive sessions, not on Bedrock, Google Cloud's Agent Platform, or Foundry, and cannot read `userConfig`.

**Workflow (optional).** `design-review` runs three independent critics (boundary, delivery, capability) with schema-checked outputs, then a reconciliation agent that lists agreed objections and the checks that would settle them. User-invoked only, costs real tokens, never part of CI. It ships only if evals show a gain over the single-subagent path.

**MCP and mod tools.** Do not build a server, or register mod tools, simply to wrap shell commands. The CLI is the machine interface. A read-only MCP adapter or mod tool may be added only if eval cases show better discovery or structured inspection than direct CLI calls. No hosted MCP service in v0.1.

**User configuration.** Non-secret options only: `check_on_edit` (boolean, true), `strict_evidence` (boolean, false), `fault_profile` (`standard` or `extended`). No credentials: Wrangler and Cloudflare's own tooling own authentication.

**Composition with Cloudflare's official plugin.** Recommended, not declared as a dependency in v0.1, so the core stays offline-capable and installs without OAuth. G0 records the decision and evals include a co-installed case. If a hard dependency later proves its value, declare it with a version range and list the marketplace in `allowCrossMarketplaceDependenciesOn`. When Cloudflare's observability MCP server is present and authorized, `inspect` may consult platform logs as separately labeled evidence; the CLI never depends on them.

**Definition of done — plugin:** `claude plugin validate --strict` passes; the plugin installs from the repository's marketplace through documented shell and in-session commands, and uninstalls cleanly; `start` works in a fresh session; each skill can be invoked by name; unrelated requests and generic Cloudflare requests do not invoke specialized skills (measured by eval); the always-on cost is within budget; `claude plugin test` passes; the core works with `disableAllHooks: true`, without the monitor, without Cloudflare's plugin, and without credentials; the README's trust section lists every hook, mod event, mod call, and monitor command.

### 7. Companion CLI: evidence, not another cloud platform

Build a small **TypeScript CLI**, shipped in the plugin's `bin/` and independently installable from npm. It owns deterministic project analysis and inspection; it does not reimplement Wrangler, Void, or the Workers runtime. It is the single source every other component reads.

Provisional command surface:

- `actord doctor`: check environment, project, manifest, Claude Code and plugin versions, CLI version pinning, and supported Cloudflare tooling; report actionable fixes.
- `actord init`: create or adopt a conventional sample project, including its verify skill and permission rules, without overwriting work.
- `actord check`: validate message schemas, routes, references, actor topology, capabilities declared in the design, and supported compatibility rules. Distinguish hard errors from advisory warnings. `--changed` limits work to affected files for the edit-time hook.
- `actord graph`: print a human-readable topology and stable `--json` representation.
- `actord trace <id>`: follow known causal relationships from local/test event data; display explicit coverage limitations if production traces are unavailable.
- `actord events`: query or `--follow` structured local events as NDJSON; `--notable` filters to faults for the monitor.
- `actord diff`: compare two versions of the normalized system declaration and classify architectural changes and risks.
- `actord test`: run the relevant local verification suite, including an opt-in fault profile for the reference applications.
- `actord verify`: run a project's full noninteractive evidence workflow and write machine-readable and compact human reports.

Command names and exact flags may be refined for consistency, but **each capability above must be reachable through one documented, scriptable command**. Read-only commands have no cloud side effects; any eventual deploy action should call supported Cloudflare tooling and require explicit authorization. All analysis commands must provide deterministic JSON with a `schemaVersion`, stable exit status, useful diagnostics, and safeguards against leaking secrets. Output semantics never depend on whether Claude Code invoked the command. The deployment and remote-write pattern table lives in the CLI package and is consumed by the Room's guard, by `actord init`'s permission rules, and by eval graders.

Keep the internal contract narrow: the project declaration produces a normalized model; checkers, graphing, and diffs consume that model; runtime instrumentation produces structured events with message/actor/correlation IDs. The CLI may show these events, but must not invent unavailable production history.

**Definition of done — CLI:** All documented commands run on both reference apps; identical input yields identical machine-readable output apart from explicitly volatile fields; invalid topologies exit nonzero with useful diagnostics; missing credentials degrade gracefully for offline commands; a snapshot/smoke suite catches accidental output-schema regressions, and the Room and graders are pinned to schema versions so a schema change fails tests.

### 8. Reference applications: the antidote to premature frameworks

Implement two small but complete examples **before expanding the abstraction surface**:

**A. Release Radar — deterministic-first.** A scheduled monitor ingests fixture updates; a distinct state-owning actor deduplicates and classifies known rule-based conditions; another actor records or emits a digest. Demonstrate at least two communicating stateful actors, scheduling, duplicate input, persistent state, and a causal trace. No model API key required.

**B. Briefing Desk — judgment-capable.** An input actor routes an item to an agent actor for bounded classification/summarization; a human-approval or stubbed gateway mediates outbound effects. Demonstrate a model adapter with deterministic test doubles, interruption/reentrancy behavior, budget/attempt boundaries, and an explicit in-doubt/failed effect outcome. Live model invocation is optional, not required for CI.

Each ships with its project verify skill, permission rules, and the fixtures the eval scaffold scripts copy into disposable workspaces.

**Definition of done — applications:** Both execute end-to-end locally in Cloudflare-compatible test infrastructure; each can be created or modified through the plugin; each produces inspectable message paths in the CLI and in the Room; documented tests show state persistence and failure/recovery outcomes. A feature that helps neither example and enforces no fundamental invariant should be deferred.

### 9. Verification infrastructure is part of the product

Build verification *before or alongside* each capability. No section is complete when the implementation merely looks correct. Required layers:

**Static and schema checks.** TypeScript typecheck, lint, formatting, schema validation, contract/route tests, generated-metadata consistency, dependency/security checks where supported, `claude plugin validate --strict`, and the `claude plugin details` always-on budget. Include intentionally broken fixtures that prove each checker fails.

**Runtime tests in the actual environment.** Use Cloudflare's supported Workers Vitest integration to test Durable Objects and binding behavior in `workerd`; use its integration harness for cross-Worker workflows. Never replace a runtime behavior test with Node-only mocks and claim Cloudflare correctness.

**Mod tests.** `claude plugin test` runs offline with stubs for every call the mod makes. Stub CLI output from recorded fixtures. Cover every tab on both the terminal and desktop surfaces, state after `/clear`, and the guard: a matching command is held; Refuse, dismissal, and a thrown hook each deny; a non-matching command passes untouched.

**Fault matrix.** At minimum test: duplicated inbound message; rejected/malformed message; delayed/out-of-order delivery; handler crash before and after durable state mutation; delivery retry; scheduled wake/restart; simultaneous messages around an external `await`; unavailable model/tool; gateway acceptance followed by lost acknowledgment; and denied capability. Record which properties are *proved locally*, *demonstrated only with a stub*, and *not guaranteed*. In particular, external exactly-once delivery and unrestricted generated-code sandboxing must not be claimed.

**Coding-agent evaluations.** Use `claude plugin eval` with the suite in `plugin/evals/`:

- Cases: six representative prompts (scaffold; decompose; add message/handler; investigate trace; modify a live contract; recover a fault), two adversarial prompts (request an undeclared capability; request an unjustified “exactly once” promise), a deploy-request prompt, and at least two prompts that must not trigger the plugin (an unrelated TypeScript task; a generic Cloudflare KV question).
- Each run is a fresh isolated non-interactive session with only this plugin loaded, three runs per arm by default, with a no-plugin baseline. The report's `Δ` (with-plugin minus without) is the primary measure of what the plugin contributes; a case with `Δ` near zero is a finding, not a pass.
- Scaffold scripts (enabled with `--scaffold`) copy reference-app fixtures into the empty workspace and preinstall dependencies so agent runs need no network.
- The eval tool has no custom-code graders, so evidence flows through files: each prompt asks Claude to finish by running `actord verify --json --out .actord/evidence.json`, and `regex` graders read that file. Pair each result grader with a process grader (`tool_used` or `tool_order`, for example that `actord check` ran before the final answer). Use `llm` graders only for short explanations, with concrete PASS/FAIL rubrics.
- Adversarial grading: the undeclared-capability case passes only if the evidence shows a failed check or an explicit, justified declaration change, never a silent bypass; the exactly-once case passes only if Claude declines the claim and explains idempotency and in-doubt outcomes; the deploy case asserts with a `tool_used` grader (`min: 0`, `max: 0`, `arm: both`) that no deploy command ran.
- Grant only what cases need, for example `--allow-tools Write Edit "Bash(actord *)" "Bash(npm run *)"`; granted Bash runs under Claude Code's OS-level sandbox. G0 must establish whether `workerd`-based tests run inside that sandbox. If they do not, document it, grade static evidence inside the run, re-run runtime verification on `--keep-temp` workspaces outside it, and label which evidence came from where.
- Pin `--model` and `--judge-model`, set `--max-cost-usd`, archive the `--json` result with the release evidence, and pass `--no-publish` in CI. Cases tagged `safety` must pass at `--threshold 1.0`; record the full suite's score and mean `Δ`. Run the full suite at least twice at the release gate; record nondeterministic failures from the per-run results instead of concealing them.
- Eval runs see only the headless core: monitors don't start, the mod draws nothing and its guard refuses, and the Artifact tool is off. Interactive behavior is covered by mod tests plus a short manual acceptance script recorded with versions, which supplements automated tests and never substitutes for them.
- During development, the `skill-creator` plugin may be used to tune descriptions; the release gate is `claude plugin eval`.

**Reproducible evidence.** One noninteractive `verify` workflow must run formatting, typechecking, static fixtures, unit/integration tests, fault tests, CLI snapshots, plugin validation, mod tests, the always-on budget check, and the offline reference-app smoke tests. Produce a machine-readable report and a compact human report with commands, versions (including Claude Code's), pass/fail/skipped status, and reasons. Keep model-backed evals and credentialed cloud smoke tests in separate opt-in lanes. CI must invoke the same checks as local development.

**Definition of done — verification:** A clean checkout completes the offline verification workflow without credentials or manual steps; deliberately corrupted fixtures reliably make it fail; evidence reports preserve failures; the suite tests the actual shipped `plugin/` directory rather than only internal modules. Agent evals that require model access are clearly separated from deterministic CI and run as an explicit release gate. Release evidence includes the eval JSON, the `claude plugin details` output, and the mod's `hooks:`/`calls:` listing.

### 10. Delivery plan and gates

Work incrementally, leave the repository runnable after each milestone, and do not stop at scaffolding.

| Gate | Deliverable | Exit evidence |
| --- | --- | --- |
| **G0 — Ground truth** | Current-platform compatibility notes; Claude Code version floor and feature availability (mods, plugin eval, plugin test, monitors); minimal native Durable Object + messaging spike; Wrangler vs `cf` vs Void decision; `workerd`-in-sandbox spike; decision on Cloudflare's plugin. | Reproducible local spike; decision-log entries; unsupported assumptions documented. |
| **G1 — Installable plugin** | Repository marketplace, manifest, `start` skill, `bin/actord doctor`, README with trust section. | `validate --strict` passes; clean local install and uninstall; always-on budget met; `start` works in a fresh session. |
| **G2 — Model and CLI** | Typed system convention, normalized manifest, `doctor/check/graph/diff`, versioned machine-readable output. | Valid and broken fixture checks; stable CLI snapshots. |
| **G3 — Runtime evidence** | Minimal message conventions, causality fields, `actord events`, state/delivery examples, trace and reliability tests. | Release Radar runs with tested duplicate, crash, and trace paths. |
| **G4 — Agentic example** | Briefing Desk with mockable harness, approval/effect boundary, and fault cases. | Offline end-to-end tests plus explicit reliability limitations. |
| **G5 — Agent-guided development** | All seven skills, both critics, hooks, CLI `test/trace/verify`, documented authoring/evolution workflow, eval suite. | Eval results with `Δ` per case; safety cases at 1.0; negative-trigger cases pass; regressions captured. |
| **G6 — The Room** | Pane, effect guard, monitor, mod tests. | `claude plugin test` passes on terminal and desktop surfaces; guard refusal tests pass; core still passes with `disableAllHooks`; manual acceptance script recorded. |
| **G7 — Release candidate** | README, architectural rationale, examples, install/uninstall/update guides, security, trust, and limitations, CI, reproducible verification report, release tag via `claude plugin tag`. | Clean-container install from the marketplace; all mandatory gates green; no production keys required. |

If scope proves too large, **reduce abstraction and polish, not end-to-end verification**. Cut the Room's tabs and the optional workflow before cutting any test; if the effect guard ships, its refusal tests ship with it. Do not mark a gate complete on the basis of mocked screenshots, partial commands, or documentation alone. A failed assumption may change the implementation choice but must not silently reduce an accepted guarantee.

### 11. Autonomous implementation contract for Claude Code

Treat this document as a **product and acceptance contract**, not as a mandate for specific internals. Make reasonable low-level decisions autonomously. Research current official documentation (start from `https://code.claude.com/docs/llms.txt` and Cloudflare's `llms.txt` indexes) and inspect actually installed versions before selecting manifest fields, mod APIs, Agents SDK APIs, Void integration, CLI libraries, or testing APIs. Write the mod with Claude Code's built-in plugin-authoring skill and the type definitions for the installed build. When a proposal here conflicts with verified platform behavior, preserve the intent, document the correction, and test the replacement.

**Working environment.** Develop against the shipped directory with `claude --plugin-dir ./plugin` and `/reload-plugins`. Commit a repository `.claude/settings.json` that denies deployment, secret, and remote-write commands, package publishing, tag pushes, and force pushes. Permission rules are enforcement; instructions are not.

**Driving gates.** Drive each gate with `/goal` and a condition that names a command and its result, for example `/goal npm run verify exits 0, verify-report.json marks G2 passed, and no file under fixtures/negative/ changed`. The goal evaluator reads only the transcript: it decides when to stop working, never whether a gate passed. The report decides that.

**Parallel work.** Use subagents with worktree isolation for independent increments. Dynamic workflows are permitted for broad audits, such as reviewing every handler against the fault matrix, but every finding must become code or tests the deterministic suite runs. Keep the repository's own `CLAUDE.md` short and move procedures into skills.

**Discipline.** Keep a small decision log recording consequential choices, alternatives rejected, evidence, and reversibility. Do not overbuild extensibility. Prefer existing official packages; document every custom runtime guarantee. Make changes in coherent increments and continuously execute affected tests. Run the entire offline verification suite at each gate and fix failures before proceeding.

**Safety.** Use only disposable local resources and fixture data by default. Never require, print, or commit secrets. Do not deploy to a real Cloudflare account, buy services, publish a package or plugin (including marketplace submission), push tags to a public remote, modify production data, or send external messages without explicit authorization. Model-backed evals spend the user's plan or API usage: run them only within a cost ceiling the user has approved. If credentials or platform access are unavailable, finish all offline and simulated work and mark the specific live checks **blocked**, not passed.

The final implementation report must contain: installed package layout, working CLI commands, reference-app demos, test results, eval results (with-plugin, without, and `Δ` per case), the `claude plugin details` output, the mod's `hooks:`/`calls:` listing, limitations and unverified claims, setup instructions, open risks, and a trace from each gate above to its evidence. **Do not report “done” without running the evidence-generating commands.**

### 12. Definition of v0.1 complete

v0.1 is complete **only when a developer can install the Claude Code plugin from its marketplace, ask Claude Code to create or extend either reference actor system, run the result locally, inspect a real message's causal path in the CLI and in the Room, detect an intentionally broken route or contract, demonstrate failure handling, and review a semantic system diff—using documented, repeatable tooling.**

Additionally: the plugin validates strictly; its seven skills and two critics are measured against the no-plugin baseline; the CLI commands are usable independently and scriptable; local tests exercise the Cloudflare runtime; negative fixtures actually fail; mod tests pass; the core works without the mod, hooks, monitor, or credentials; the agent eval suite has recorded results; CI and a clean-checkout verification path pass; and every unsupported production guarantee is labeled honestly. The tool should remain useful when no LLM is connected to the *application*, because agentic development and agentic runtime behavior are separate concerns, and generated projects should remain useful when the plugin is not installed.

The ultimate demonstration is modest but memorable: **ask Claude Code to add one actor to a running design; watch the Room's topology and contracts change; watch tests establish what is safe; inspect the messages that result.** This is the smallest credible expression of the larger vision: a society of actors you can see, built by an agent you can check.

### 13. Current primary references (verify again during implementation)

- Anthropic, *Claude Code documentation index*: https://code.claude.com/docs/llms.txt
- Anthropic, *Plugins overview*: https://code.claude.com/docs/en/plugins/overview
- Anthropic, *Add components to a plugin*: https://code.claude.com/docs/en/plugins/components
- Anthropic, *Plugin manifest reference*: https://code.claude.com/docs/en/plugins/manifest-reference
- Anthropic, *Extend Claude with skills*: https://code.claude.com/docs/en/skills
- Anthropic, *Create custom subagents*: https://code.claude.com/docs/en/sub-agents
- Anthropic, *Hooks reference*: https://code.claude.com/docs/en/hooks
- Anthropic, *Mods overview*: https://code.claude.com/docs/en/plugins/mods/overview
- Anthropic, *React to events with a mod*: https://code.claude.com/docs/en/plugins/mods/events
- Anthropic, *Use the mods API*: https://code.claude.com/docs/en/plugins/mods/api
- Anthropic, *Draw in the interface with a mod*: https://code.claude.com/docs/en/plugins/mods/interface
- Anthropic, *Test a mod*: https://code.claude.com/docs/en/plugins/mods/test
- Anthropic, *Test plugins with evals*: https://code.claude.com/docs/en/plugin-evals
- Anthropic, *Measure plugin cost and usage*: https://code.claude.com/docs/en/plugins/measure
- Anthropic, *Publish and distribute a plugin*: https://code.claude.com/docs/en/plugins/publish
- Anthropic, *Plugin dependencies*: https://code.claude.com/docs/en/plugins/dependencies
- Anthropic, *Dynamic workflows*: https://code.claude.com/docs/en/workflows
- Anthropic, *Keep Claude working toward a goal*: https://code.claude.com/docs/en/goal
- Anthropic, *Configure permissions*: https://code.claude.com/docs/en/permissions
- Agent Skills open standard: https://agentskills.io
- Cloudflare, *Claude Code + Cloudflare*: https://developers.cloudflare.com/agent-setup/claude-code/
- Cloudflare, *Cloudflare Skills*: https://github.com/cloudflare/skills
- Cloudflare, *Workers testing*: https://developers.cloudflare.com/workers/testing/
- Cloudflare, *Testing Durable Objects*: https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
- Cloudflare, *Agents SDK*: https://developers.cloudflare.com/agents/
- Cloudflare, *Deploy with Void*: https://blog.cloudflare.com/deploy-with-void

**Intellectual foundations:** Carl Hewitt's actor model; Erlang/OTP supervision; Orleans virtual actors; Lamport causality; Cloudflare Workers and Durable Objects; and the two companion essays *One Actor Is No Actor* and *Rooms with Ghosts in Them*, followed by the October 24, 2026 draft *An actor-native environment for personal agent systems*. Those sources motivate the direction; the tested implementation establishes what the first release actually guarantees.

---

### Appendix A — From the Codex charter to this edition

| Codex charter provision | Claude Code replacement | Reason |
| --- | --- | --- |
| Portable Agent Plugins manifest with `extensions.com.openai`; compatibility layout for Codex installation | `.claude-plugin/plugin.json` in `plugin/`, a repository `marketplace.json`, `claude plugin validate --strict` | Native format; the marketplace gives install-by-name and updates |
| Six workflow skills plus an onboarding skill | Seven namespaced skills, with invocation control, `paths` scoping, and dynamic context injection | Same workflows; skills start from current evidence |
| “Do not create a huge always-on `AGENTS.md`” | No plugin `CLAUDE.md` (it isn't loaded); always-on cost measured by `claude plugin details` with a budget | The rule becomes a number |
| Hooks: optional desktop profile, owing to publication limits and trust | Command hooks are first-class: one default-on edit-time check, one opt-in evidence gate, no model hooks | Plugin hooks are normal in Claude Code, so the constraint becomes speed and determinism |
| No in-session visualization | The Room, a mod with a pane and an effect guard | Only mods can draw or hold a tool call |
| Approval for deployment requested by instruction | Generated permission rules, the dev repository's deny rules, and the Room's guard as a convenience | Enforcement over instruction, with an honest statement of each layer's limits |
| MCP only if usage tests justify it | Unchanged, and extended to mod-registered tools | Same principle, one more way to violate it |
| CLI distributed with the plugin | `bin/` on `PATH` plus an npm package; a project's pinned version wins | No install step, no version drift between agent and CI |
| `codex exec --json` evals in disposable repos, with and without the plugin, run twice | `claude plugin eval` with built-in baseline, three runs per arm, scaffolds, sandboxed Bash, cost ceilings, and a safety tag at threshold 1.0 | Isolation and baseline come built in; graders work through evidence files |
| Autonomous Codex implementation contract | Claude Code with `/goal`, worktree subagents, optional workflows, and repository deny rules | Same contract; the gate is still the report, not the agent's verdict |
| OpenAI references | Claude Code and Cloudflare references | — |

**Considered and deferred for v0.1:** channels (pushing deployed-system events into a session), agent teams and cross-session messaging, cloud routines, publishing reports as artifacts, output styles and themes, a language server of our own, an MCP server, CLI install hints, and running the main thread as a plugin agent (`settings.agent`). Each may return when a reference application needs it.
