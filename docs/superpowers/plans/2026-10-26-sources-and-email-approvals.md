# Sources and email approvals (plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let actord systems receive the outside world through declared sources, a GitHub webhook (`@github`) and email (`@email`), and let a person approve or deny a parked effect by replying to an email.

**Architecture:**
- **Sources.** They're declared once per system in `system.ts`, next to actors and effects. Each one becomes a named external sender, alongside `@clock`, `@ingress` and `@timer`.
- **Generated handlers.** A small toolkit module, `@actord/toolkit/sources`, supplies the Worker's handlers. Each one verifies the request, derives a stable id, maps the provider's payload to the system's own message, and delivers it with the same envelope path `ingress` uses. Actors never subscribe.
- **Asking for approval.** When an effect parks for approval, the runtime asks for it automatically through the system's declared notify effect. That's an email carrying a signed token in its subject.
- **Answering by email.** The owner's reply arrives through `@email`, is checked by plain code, and reaches the actor as `approval.decided`.

**Tech Stack:** TypeScript 7.0.2, `agents@0.30.1` (unchanged), `postal-mime` (bundled; pin the newest 4.x release at implementation time and record it), Web Crypto HMAC-SHA256, Cloudflare Email Service (`send_email` binding) and Email Routing (`email()` handler), vitest 5.0.5 with `@cloudflare/vitest-plugin` 1.4.7.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-sdk-foundation-design.md`: §6 (sources), §8 (approvals and channels), §11 (the tests for sources and approvals), §12 spike 6, §2 and §4 (constraints). Plan 1 (`docs/superpowers/plans/2026-10-25-actord-lifecycle-foundation.md`) is merged. This plan builds on its runtime: Lifecycle capability, timers, approval expiry, and `ctx.approve`/`ctx.deny` with identity.

**Where this plan sits:** it's plan 2 of 5. Plan 3 covers agent actors on Pi and Computer, plan 4 Clef and Clairic effects, and plan 5 the plugin skills.

## A design correction this plan makes (recorded in Task 7)

The spec (§8.2) says replies are matched by "HMAC-signed routing headers" via the Agents SDK's `createSecureReplyEmailResolver`. That resolver reads custom `X-Agent-*` headers on the *incoming* message (`agents/src/email.ts`, `createSecureReplyEmailResolver`). A person replying from Gmail sends a new message that doesn't carry the original's custom headers, so that check can't match a human reply.

**Designer's call:** the signed token travels in the subject, as `[actord:<token>]`, which mail clients keep when replying ("Re: …"). It's also set as a custom header, which nothing relies on. An HMAC guards the token, so an edited subject is simply refused.

Spike 6 (Task 8) confirms this against real Gmail and records which `Authentication-Results` reach the Worker.

Other transports were considered and set aside for now:
- **A token in a `+` subaddress of `Reply-To`.** The email local part is limited to 64 characters, too short for a signed token without a server-side lookup.
- **Matching `In-Reply-To` against a `Message-ID` we set.** Unknown whether the `send_email` binding lets us set `Message-ID`; spike 6 checks this.

## Global Constraints

- **Pins.** `agents` stays pinned at exactly `0.30.1` and external to the bundles. `postal-mime` and the HMAC code are bundled into the `sources` entry. There are no new runtime dependencies for apps.
- **Answer quickly.** A source handler always answers within one request: verify, map, validate, deliver, respond. It never awaits an actor's handler beyond the `receive()` RPC, which is the same cost `ingress` has today.
- **Status codes, verbatim from spec §6.2:**
  - an unmapped event is answered `204` and recorded as `source.ignored`;
  - a failed verification is answered `401` and recorded;
  - a failed mapping or validation is answered `400` and recorded with the delivery id.
- **Ids.**
  - A webhook delivery's envelope id is its provider delivery id (`X-GitHub-Delivery`), so a redelivery is deduplicated by the inbox.
  - An email's envelope id is `deriveId("email", <the reply's Message-ID header>)`.
- **Email approval rules, spec §8.2. An `@email` reply counts only if all of these hold:**
  1. its token verifies and hasn't expired;
  2. its sender is the owner's address;
  3. its first meaningful line is `approve` (case-insensitive, trimmed) or starts with `deny` (the rest is the reason).

  These rules are parsed by plain code, never by a model. Anything else gets a reply asking again.
  - A reply from someone other than the owner gets no reply and is recorded as `source.rejected`.
  - Approve links are never sent.
- **Email authentication (the owner's decision, spec §8.2).**
  - If the reply's `Authentication-Results` shows `dmarc=pass`, the reply is `authenticated: "pass"`.
  - If the header is missing, it's `"unknown"`.
  - If it shows `dmarc=fail`, the reply is refused.
  - With `"unknown"`, an email may approve mid-run tool calls but never an effect declared `publishes: true`. The sender is told to approve that one in GitHub.
- **The approver's identity** (`by`) is the verified sender address.
- **Tests.** Every new guarantee has a tagged workerd test in `packages/toolkit/test-runtime/runtime.test.ts`, or in a new `packages/toolkit/test-runtime/sources.test.ts`, or is written down as not guaranteed. Tests must discriminate: each task's report includes one mutation check per guarantee.
- **Test hygiene, from plan 1.**
  - Never resolve, from the test context, a Promise that was created inside a Durable Object.
  - Never let a test depend on a timeout racing `settle()`. A `settle()` round drives every instance in the file.
  - Check exit codes, and check that no `Errors` or `Unhandled` line appears.
- **Rebuild.** After any change under `packages/toolkit/src`, run `npm run build -w @actord/toolkit` and commit the tracked rebuilt artifacts: `plugins/*/dist` and `plugins/claude/hooks/effect-patterns.ts`. `packages/toolkit/dist/` is git-ignored.
- **Manifests.** When the manifest's shape changes, regenerate the manifest of both examples and every fixture whose `system.ts` loads, except `fixtures/negative/manifest-stale` and `fixtures/negative/declaration-load-failed`. Then rebuild again.
- **Out of scope.**
  - No version bump, npm release, paid eval run or plugin skill edits.
  - No deploy, `wrangler secret`, or remote-resource command. The repo's `.claude/settings.json` denies them. Task 8's steps that need them are run by the owner with `!`.
- **Not in this plan.**
  - Polling sources (spec §6.3, "later").
  - Generating the GitHub App's subscribed events from the declaration (spec §6.3 says it "can be"). That comes with the factory.
  - Telegram, Slack and other Chat SDK channels.

## Review Focus

These are the inputs most likely to bite that no task's tests would otherwise exercise. Each one's test is assigned to the task that owns it.

1. **A GitHub delivery whose body was re-serialised.** Whitespace changes after the signature was computed, for example by a proxy. Expected: `401`. The signature is checked over the raw request bytes, before any JSON parse. → Task 3, `[source-raw-body]`.
2. **The same GitHub event delivered twice with the same `X-GitHub-Delivery`** (GitHub's manual redelivery). Expected: the actor handles it once, and the second answer is still `202`, since a duplicate is not an error. → Task 3, `[source-redelivery]`.
3. **An owner's reply that quotes the original request below their answer.** Gmail's "On … wrote:" block contains the word "approve". Expected: only the first line the owner wrote counts. A reply whose only "approve" is inside the quoted text asks again. → Task 6, `[email-quoted-approve]`.
4. **A reply that arrives after the approval request expired.** Expected: no delivery to the actor, and the owner gets a short "this request expired" reply. That mirrors plan 1's late-approval rule. → Task 6, `[email-expired-token]`.
5. **The owner replying twice** (two approves, or approve then deny). Expected:
   - the first decision wins;
   - the second reply is a different email with its own Message-ID, so it is delivered;
   - the actor's `ctx.approve` or `ctx.deny` then returns `false`, because nothing is waiting.

   → Task 6, `[email-second-reply]`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/toolkit/src/system.ts` | `sources`, `SourceSpec`, `webhook()`, `inboundEmail()`, `approvals: { notify }`, `EffectSpec.publishes`, the `@<source>` sender typing |
| `packages/toolkit/src/sources/index.ts` (new; entry `@actord/toolkit/sources`) | Re-exports `handleWebhook`, `handleEmail`, `approvalEmail`, `applyDecision`, `approvalDecided` |
| `packages/toolkit/src/sources/webhook.ts` (new) | Path match, GitHub HMAC check over the raw body, event naming, map/validate/key, delivery, responses, source events |
| `packages/toolkit/src/sources/token.ts` (new) | Sign and verify approval tokens (HMAC-SHA256, base64url, expiry, constant-time compare) |
| `packages/toolkit/src/sources/email.ts` (new) | Inbound: MIME parse (postal-mime), token, owner, authentication, first-line parse, the publishes guard, re-ask replies, delivery |
| `packages/toolkit/src/sources/approval-email.ts` (new) | Outbound: the `approvalEmail(...)` effect adapter that composes and sends the request email |
| `packages/toolkit/src/runtime/index.ts` | `deliverExternal()` (the shared body of `ingress`); automatic approval notification when an effect parks |
| `packages/toolkit/src/model/{check,manifest,diff,mermaid}.ts` | Rules, the manifest's `sources` section, diff classification, source nodes in the graph |
| `packages/toolkit/build.mjs`, `packages/toolkit/package.json` | The new `sources` entry and its export |
| `packages/toolkit/test-runtime/src/index.ts`, `test-runtime/sources.test.ts` (new), `test-runtime/wrangler.jsonc` | The probe system's sources, its Worker `fetch`/`email` handlers, the tests |
| `fixtures/negative/source-*` (new) | One negative fixture per new error rule |
| `spikes/email-approval/` (new) | The spike-6 Worker (Task 8) |
| `docs/decisions/0017-sources.md`, `docs/decisions/0021-approvals-by-email-reply.md`, `docs/wiki/Runtime.md`, `docs/wiki/Limitations.md`, the spec §8.2 amendment, `docs/evidence/spike-6-email.md` | Docs and evidence |

---

### Task 1: Source declarations, checks, manifest, graph and diff

**Files:**
- Modify `packages/toolkit/src/system.ts`:
  - types and the constructors `webhook()`/`inboundEmail()`;
  - `SystemSpec` gains a `Sources` generic, plus `sources?` and `approvals?`;
  - `RouteSpec.from` accepts `` `@${SourceName}` ``;
  - `EffectSpec.publishes?: boolean`.
- Modify `packages/toolkit/src/model/check.ts`. `EXTERNAL` becomes the fixed senders plus `@<name>` for each declared source. Add these rules:
  - `SOURCE_ROUTE_MISSING` (error): a mapped event's message has no route from `@<source>`;
  - `SOURCE_ROUTE_AMBIGUOUS` (error): more than one route from `@<source>` carries that message;
  - `SOURCE_PATH_DUPLICATE` (error);
  - `SOURCE_SECRET_UNDECLARED` (warning): the secret's name is absent from `wrangler.jsonc` `vars` and from `.dev.vars.example`;
  - `APPROVAL_NOTIFY_UNDECLARED` (error): an actor has an `approval: "human"` effect while `approvals.notify` is set, but doesn't list the notify effect in its `effects`;
  - `APPROVAL_NOTIFY_NEEDS_APPROVAL` (error): the notify effect itself has `approval: "human"`;
  - `APPROVAL_ROUTE_MISSING` (error): an actor with an `approval: "human"` effect has no route from the email source carrying its `message`, when an email source exists;
  - `PUBLISHES_WITHOUT_APPROVAL` (error): `publishes: true` without `approval: "human"`.
- Modify `packages/toolkit/src/model/manifest.ts`. The manifest gains `sources: Array<{ name, kind, path: string | null, verify: string | null, events: Array<{ event, message }>, message: string | null }>` (serialisable parts only). Effects gain `publishes`, emitted only when `true`. It gains `approvals: { notify } | null`.
- Modify `packages/toolkit/src/model/diff.ts`:
  - a source added is `compatible`;
  - a source removed is `breaking`;
  - an event's mapping added is `compatible`, and removed is `risky`;
  - a `path` or `verify` change is `risky`;
  - `publishes` changed is `risky`;
  - `approvals.notify` changed is `risky`.

  Add `sources`/`approvals` to the field sets so nothing reports `unclassified`.
- Modify `packages/toolkit/src/model/mermaid.ts` so sources render as outside nodes (`x_github`), the way `@clock` does.
- Create `fixtures/negative/source-route-missing/`, `source-path-duplicate/`, `approval-notify-undeclared/` and `publishes-without-approval/`, each with an `expected.json` listing exactly its code.
- Test: `packages/toolkit/test/sources-model.test.ts` (new; Node). Fixture snapshots.

**Interfaces:**
```ts
export interface WebhookEventSpec { readonly message: string; readonly key: (event: any) => string; readonly map: (event: any) => unknown }
export interface WebhookSourceSpec { readonly kind: "webhook"; readonly path: `/${string}`; readonly verify: "github"; readonly secret: string; readonly events: Readonly<Record<string, WebhookEventSpec>> }
export interface EmailSourceSpec { readonly kind: "email"; readonly secret: string; readonly owner: string; readonly from: string; readonly send: string; readonly message: string }
export type SourceSpec = WebhookSourceSpec | EmailSourceSpec;
export function webhook<const S extends Omit<WebhookSourceSpec, "kind">>(spec: S): S & { readonly kind: "webhook" };
export function inboundEmail<const S extends Omit<EmailSourceSpec, "kind">>(spec: S): S & { readonly kind: "email" };
// SystemSpec: readonly sources?: Sources; readonly approvals?: { readonly notify: string };
// EffectSpec: readonly publishes?: boolean;
```

`secret`, `owner`, `from` and `send` are names of `env` entries: a secret, two variables and a `send_email` binding. They're never values.

An event name is `${X-GitHub-Event}.${action}` when the payload has an `action`, and the bare event name otherwise.

- [ ] **Step 1: Write the failing model tests.** In `test/sources-model.test.ts`, write these, built on a small in-file system:
  - `it("a source's sender may appear in routes, and check passes")`;
  - one `it` per new rule, asserting the exact `code`;
  - `it("the manifest lists sources without their functions")`;
  - `it("diff classifies source changes")`, with the `compatible`/`risky`/`breaking` values above;
  - `it("the graph draws a source as an outside node")`, expecting the Mermaid output to contain `x_github(["@github"])`.

  Add `@ts-expect-error` cases to `packages/toolkit/test/types/system.types.ts` for:
  - a route `from: "@github"` when no `github` source is declared;
  - `publishes` on a non-boolean.
- [ ] **Step 2: Run them to verify they fail.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run test/sources-model.test.ts)`
  - Expected: FAIL (`webhook is not a function`, or missing codes).
- [ ] **Step 3: Implement the types, the constructors, the check rules, the manifest, diff and mermaid.**
- [ ] **Step 4: Add the four negative fixtures. Regenerate the manifests per the Global Constraints, rebuild, then run everything.**
  - Run: `(cd packages/toolkit && npx vitest run -u && npx vitest run && npx tsc --noEmit) && npm test -w release-radar && npm test -w briefing-desk`
  - Expected: all pass. The snapshot diff shows only `sources: []` and `approvals: null` added to manifests.
- [ ] **Step 5: Commit.**
  - Message: `Sources are declared in system.ts and checked, drawn and diffed`, plus the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

---

### Task 2: External delivery under a source's name

**Files:**
- Modify `packages/toolkit/src/runtime/index.ts`. Extract the body of `ingress()` into `deliverExternal(env, system, from, to, type, payload, options)`, and keep `ingress()` as a call to it with `from: "@ingress"`. `receive()`'s route check already accepts any `@…` sender found in `system.routes`. Confirm that with the test.
- Test: `packages/toolkit/test-runtime/runtime.test.ts`.

**Interfaces:**
```ts
/** Deliver into the system from an external sender ("@ingress", "@github", "@email", ...). Exported for @actord/toolkit/sources. */
export async function deliverExternal(env: unknown, system: AnySystem, from: `@${string}`, to: string, type: string, payload: unknown, options: { key?: string; id?: string; correlationId?: string } = {}): Promise<Receipt>;
```

- [ ] **Step 1: Write the failing tests.** Give the probe system a declared source `hooks`, built with `webhook({ path: "/hooks/probe", verify: "github", secret: "PROBE_HOOK_SECRET", events: { "probe.poke": { message: "probe.poked", key: (e) => e.key, map: (e) => ({ key: e.key }) } } })`, and a route `{ from: "@hooks", message: "probe.poked", to: "Probe" }`. Then add:

```ts
it("[external-sender] a message from a declared source's sender is accepted on its route", async () => {
  const r = await deliverExternal(env, system, "@hooks", "Probe", "probe.poked", { key: "ext" }, { key: "ext", id: "d-1" });
  expect(r).toMatchObject({ status: "handled", messageId: "d-1" });
});
it("[external-sender-route] the same message from a sender with no route is refused", async () => {
  const r = await deliverExternal(env, system, "@other", "Probe", "probe.poked", { key: "ext2" }, { key: "ext2" });
  expect(r).toMatchObject({ status: "rejected", reason: "unauthorized_route" });
});
```

- [ ] **Step 2: Run them to verify they fail, then implement.**
- [ ] **Step 3: Run the runtime suite.** Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts`. Expected: exit 0, no Errors line.
- [ ] **Step 4: Build and commit.** Message: `deliverExternal: ingress under any declared source's name`.

---

### Task 3: The GitHub webhook handler

**Files:**
- Create `packages/toolkit/src/sources/webhook.ts` and `packages/toolkit/src/sources/index.ts`.
- Modify `packages/toolkit/build.mjs`: a `sources` library entry, `platform: "neutral"`, with `external: ["agents", "agents/*", "cloudflare:workers"]`.
- Modify `packages/toolkit/package.json`: add an `exports["./sources"]`.
- Modify `packages/toolkit/test-runtime/src/index.ts`. Its default `fetch` becomes `(request, env) => handleWebhook(request, env, system) ?? new Response("runtime probe")`, written as an `await` with a null check. Add `"vars": { "PROBE_HOOK_SECRET": "test-secret" }` to `test-runtime/wrangler.jsonc`.
- Test: `packages/toolkit/test-runtime/sources.test.ts` (new). It uses `SELF.fetch` from `cloudflare:test`.

**Interfaces:**
```ts
/** Handle a request if its path belongs to a declared webhook source; null otherwise, so the app's own routes run. */
export async function handleWebhook(request: Request, env: unknown, system: System): Promise<Response | null>;
```

**Behaviour:**
1. Find the webhook source whose `path` equals the URL pathname. If none matches, return `null`.
2. Allow `POST` only; anything else gets `405`.
3. Read the raw body as bytes.
4. Verify: `X-Hub-Signature-256` must be `sha256=` followed by the lowercase hex HMAC-SHA256 of the raw body, keyed with `env[secret]`, compared in constant time.
   - On failure: `401`, recording `source.rejected { source, reason: "signature" }`.
   - If the secret is missing from `env`: `500`, recording `source.rejected { reason: "secret_missing" }`.
5. Read the id from `X-GitHub-Delivery`. If it's missing: `400`, recording `source.invalid { reason: "delivery_id_missing" }`.
6. Parse the JSON and work out the event name.
   - If it's unmapped: `204`, recording `source.ignored { source, event, deliveryId }`.
7. Run `key(event)` and `map(event)`, then validate against the message's schema.
   - If either throws, or validation fails: `400`, recording `source.invalid { source, event, deliveryId, reason }`.
8. Find the single route from `@<source>` for the message, then `deliverExternal(env, system, "@<source>", route.to, message, payload, { key, id: deliveryId })`.
   - A receipt of `handled` or `duplicate` gives `202`.
   - `rejected` gives `400`, recording `source.invalid`.
   - `failed` gives `500`. GitHub won't retry, so record `source.failed` with the delivery id.
9. Record each of these events through the runtime's existing `emit()`, with `actor` set to `"@<source>"`.

**Steps:**
- [ ] **Step 1: Write the failing tests.** Add a helper `signed(body: string, secret = "test-secret")` that computes the header with Web Crypto in the test, then:

```ts
it("[source-delivers] a signed, mapped GitHub delivery reaches its actor once, under the delivery id", async () => {
  const body = JSON.stringify({ action: "poke", key: "s1" });
  const res = await SELF.fetch("https://probe/hooks/probe", { method: "POST", body, headers: { "x-github-event": "probe", "x-github-delivery": "gh-1", "x-hub-signature-256": await signed(body) } });
  expect(res.status).toBe(202);
  expect(await probe("s1").poked()).toEqual(["gh-1"]);
});
it("[source-bad-signature] a delivery with a wrong signature is refused with 401 and never delivered", async () => { /* status 401; poked() empty; captureEvents shows source.rejected reason "signature" */ });
it("[source-raw-body] a body re-serialised after signing is refused", async () => { /* sign JSON.stringify(obj), send JSON.stringify(obj, null, 2) → 401 */ });
it("[source-redelivery] the same delivery id twice is handled once and answered 202 both times", async () => { /* two identical fetches → [202, 202]; poked() has one entry */ });
it("[source-unmapped] an event with no mapping is answered 204 and recorded", async () => { /* x-github-event: "ping" → 204; source.ignored with event "ping" */ });
it("[source-invalid] a payload the mapping can't turn into a valid message is 400, recorded with its delivery id", async () => { /* map yields { key: 42 } (schema wants string) → 400; source.invalid has deliveryId */ });
it("[source-not-mine] a path no source declares falls through to the app", async () => { /* GET /other → "runtime probe" */ });
```

The probe gains `probe.poked`. Its handler records `id` in a `pokes` table, read back through `poked()` RPC.

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts test-runtime/sources.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.** Do one mutation check each:
  - remove the signature comparison: `[source-bad-signature]` must fail;
  - parse JSON before verifying, then re-stringify: `[source-raw-body]` must fail.
- [ ] **Step 4: Run both runtime test files and the toolkit unit tests after building.** Expected: exit 0.
- [ ] **Step 5: Commit.** Message: `@actord/toolkit/sources: the GitHub webhook handler (verify, map, deliver, answer)`.

---

### Task 4: Approval tokens

**Files:**
- Create `packages/toolkit/src/sources/token.ts`.
- Test: `packages/toolkit/test/approval-token.test.ts` (new; Node, Web Crypto).

**Interfaces:**
```ts
export interface ApprovalClaims { readonly actor: string; readonly key: string; readonly effect: string; readonly effectKey: string; readonly exp: number }
export async function signApprovalToken(secret: string, claims: ApprovalClaims): Promise<string>;   // base64url(JSON claims) + "." + base64url(HMAC-SHA256)
export async function verifyApprovalToken(secret: string, token: string, now: number): Promise<{ ok: true; claims: ApprovalClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" }>;
export const SUBJECT_TAG: RegExp; // /\[actord:([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\]/
```

`exp` is in epoch milliseconds. Verification checks the signature before it reads any claim.

- [ ] **Step 1: Write the failing tests.**
  - `it("round-trips claims")`;
  - `it("a changed claim fails with bad_signature")`, which flips one character of the payload;
  - `it("a token past exp fails with expired")`;
  - `it("garbage is malformed")`;
  - `it("a token from a different secret fails")`;
  - `it("the subject tag finds the token inside a Re: subject")`, for example `Re: Approve notify.brief? [actord:abc.def]`.
- [ ] **Step 2: Run them to verify they fail, implement, then run them to verify they pass.**
  - Run: `cd packages/toolkit && npx vitest run test/approval-token.test.ts`
- [ ] **Step 3: Commit.** Message: `Approval tokens: HMAC-signed, expiring, carried in the subject`.

---

### Task 5: Asking for approval: automatic notification and the email adapter

**Files:**
- Modify `packages/toolkit/src/runtime/index.ts`.
  - When `runEffect` parks a row as `awaiting_approval`, and `system.approvals?.notify` names an effect this actor declares, also enqueue that effect:
    - its row id is `fx:<notify>:approval:<effect>:<effectKey>`;
    - its input is an `ApprovalRequest`;
    - it emits `effect.requested`, with `detail.approvalFor` set to the parked effect's key.
  - The enqueue is idempotent by row id, so a re-park never sends twice.
- Create `packages/toolkit/src/sources/approval-email.ts`.
- Modify `packages/toolkit/src/sources/index.ts`, which exports `approvalEmail`, `ApprovalRequest` and `applyDecision`.
- Modify `test-runtime/src/index.ts`:
  - `approvals: { notify: "notify.approval" }`;
  - `inboundEmail({ secret: "PROBE_APPROVAL_SECRET", owner: "PROBE_OWNER", from: "PROBE_FROM", send: "PROBE_SEND", message: "approval.decided" })` as source `mail`;
  - an effect `notify.approval` with `idempotency: "none"`;
  - a route `@mail → approval.decided → Probe`.

  In the tests, the `PROBE_SEND` binding is a fake that captures messages. Install it through `overrideEffect("notify.approval", approvalEmail({ ... fake ... }))`, or through a test seam on the adapter.
- Test: `test-runtime/sources.test.ts`.

**Interfaces:**
```ts
export interface ApprovalRequest { actor: string; actorName: string; key: string; effect: string; effectKey: string; description: string; input: unknown; expiresAt: number }
export interface SendEmailLike { send(message: { from: string | { email: string; name?: string }; to: string | string[]; subject: string; text: string; headers?: Record<string, string> }): Promise<unknown> }
/** The effect adapter that emails an approval request to the owner. */
export function approvalEmail(config: { send: SendEmailLike; from: string; to: string; secret: string; describe?: (request: ApprovalRequest) => { action: string; why: string; link?: string } }): EffectAdapter<ApprovalRequest, { sentAt: number }>;
/** Apply an approval.decided payload inside the actor's handler. */
export function applyDecision(ctx: { approve(name: never, key: string, identity?: { by: string }): boolean; deny(name: never, key: string, reason: string, identity?: { by: string }): boolean }, decided: ApprovalDecided): boolean;
```

**The email's contents (spec §8.2):**
- **Subject:** `Approve <effect>? [actord:<token>]`. The token has `exp = expiresAt`.
- **Header:** `X-Actord-Approval: <token>` (informational).
- **Body:** plain text, in this order:
  1. the action: `describe().action`, or by default the effect's description and the input as indented JSON;
  2. why;
  3. the link, if one is given;
  4. "If you deny it: the actor is told it was denied and the effect never runs.";
  5. "This request expires at <ISO time>.";
  6. "Reply with approve, or deny followed by a reason, on the first line."
- **Links:** no approve or deny links.

**Steps:**
- [ ] **Step 1: Write the failing tests.**
  - `[approval-notifies]`:
    - an effect that needs approval parks;
    - exactly one email is captured;
    - its subject matches `SUBJECT_TAG`;
    - its token verifies with the probe secret and names the parked effect's actor, key and `effectKey`, with `exp` equal to the row's expiry time;
    - the body contains the expiry line and no `http` approval link.
  - `[approval-notify-once]`: parking the same effect again, for example after a restart's orphan recovery, sends no second email.
  - `[approval-notify-absent]`: a system without `approvals.notify` parks without enqueuing anything.
- [ ] **Step 2: Run them to verify they fail, then implement.** Mutation check: remove the idempotent row id; `[approval-notify-once]` must fail.
- [ ] **Step 3: Run the runtime suites, then build, then run the toolkit unit tests.** Expected: exit 0.
- [ ] **Step 4: Commit.** Message: `A parked effect asks for approval by email, once, with a signed subject token`.

---

### Task 6: Answering by email: the inbound handler

**Files:**
- Create `packages/toolkit/src/sources/email.ts`.
- Modify `packages/toolkit/src/sources/index.ts`, which exports `handleEmail` and `approvalDecided`, a hand-written Standard Schema for the payload, so apps need no zod.
- Modify `packages/toolkit/package.json`, `devDependencies`, adding `postal-mime`, bundled.
- Modify `test-runtime/src/index.ts`, whose default export gains `email: (message, env) => handleEmail(message, env, system)`.
- Test: `test-runtime/sources.test.ts`. It calls `handleEmail` directly with a fake `ForwardableEmailMessage` (`from`, `to`, `headers`, `raw` as a `ReadableStream` of a MIME string, `rawSize`), built by a helper `reply({ from, subject, text, headers })`.

**Interfaces:**
```ts
export interface ApprovalDecided { effect: string; effectKey: string; decision: "approve" | "deny"; reason: string | null; by: string; authenticated: "pass" | "unknown" }
export const approvalDecided: StandardSchemaV1<ApprovalDecided>;
export interface ForwardableEmailLike { readonly from: string; readonly to: string; readonly headers: Headers; readonly raw: ReadableStream<Uint8Array>; readonly rawSize: number }
export async function handleEmail(message: ForwardableEmailLike, env: unknown, system: System): Promise<void>;
```

**Behaviour.** `handleEmail` uses the system's single email source. It runs these steps in order, and the first that fails ends it:
1. Parse the message with postal-mime.
2. Take the token from the subject tag.
   - **Missing token:** reply "this address only accepts replies to actord approval requests". Record `source.ignored`.
   - **Malformed token or bad signature:** reply the same, but record `source.rejected`.
   - **Expired token:** reply "this request expired at <time>; nothing was approved". Record `source.rejected { reason: "expired" }`.
3. Check the sender. Both the envelope `from` and the header `From` address must equal `env[owner]`, compared case-insensitively. Otherwise send no reply and record `source.rejected { reason: "not_owner" }`.
4. Check authentication. If any `Authentication-Results` header contains `dmarc=fail`, refuse with no reply and record the rejection. `dmarc=pass` means `"pass"`; otherwise the result is `"unknown"`.
5. Find the decision in the first meaningful line.
   - Take the text part, and cut it at the first line matching `/^On .+wrote:$/` or starting with `>`.
   - The first non-empty line decides. It is either:
     - `/^approve$/i`, meaning approve;
     - or `/^deny\b\s*(.*)$/i`, meaning deny with that reason (or `null` if none).
   - Anything else: reply "reply with approve, or deny followed by a reason, on the first line". Record `source.ignored { reason: "unparsed" }`.
6. Apply the publishes guard. If the token's effect is `publishes: true` and authentication is `"unknown"`, and the decision is approve, reply "this effect publishes; approve it in GitHub". Record `source.rejected { reason: "publishes_unauthenticated" }`. A deny goes through.
7. Deliver `deliverExternal(env, system, "@<source>", claims.actor, source.message, payload, { key: claims.key, id: deriveId("email", messageIdHeader) })`. The payload's `by` is the sender address.
8. Send every reply through `env[send]` with `In-Reply-To` set to the incoming Message-ID.

**Steps:**
- [ ] **Step 1: Write the failing tests.** Each uses a real token from Task 4, a parked approval from Task 5, and `settle` between steps.
  - `[email-approves]`: an owner reply of "approve" with `dmarc=pass` approves the parked effect, which then runs once. The note's `by` is the owner's address and `via` is `"@mail"`.
  - `[email-denies]`: "deny not now" denies it with reason "not now", and the effect never runs.
  - `[email-not-owner]`: a reply from another address is dropped, with no delivery and no reply.
  - `[email-bad-token]`: an edited subject token gets a reply and no delivery.
  - `[email-expired-token]` (Review Focus 4).
  - `[email-quoted-approve]` (Review Focus 3): first line "hmm", quoted "> approve" below. The test expects a re-ask reply and no delivery.
  - `[email-unknown-auth-tool]`: no `Authentication-Results` header plus "approve" approves an effect without `publishes`, with `authenticated: "unknown"` in the payload.
  - `[email-unknown-auth-publishes]`: the same reply for a `publishes: true` effect is refused with the GitHub message, and the effect stays parked.
  - `[email-dmarc-fail]`: `dmarc=fail` is refused.
  - `[email-second-reply]` (Review Focus 5).
  - `[email-duplicate-delivery]`: the same email, with the same Message-ID, handled twice is delivered once.
- [ ] **Step 2: Run them to verify they fail, then implement.** One mutation check each:
  - remove the owner check: `[email-not-owner]` must fail;
  - match "approve" anywhere in the text: `[email-quoted-approve]` must fail;
  - drop the publishes guard: `[email-unknown-auth-publishes]` must fail.
- [ ] **Step 3: Run both runtime test files, build, then run the toolkit unit tests, tsc and both examples.** Expected: exit 0.
- [ ] **Step 4: Commit.** Message: `@email: approve or deny a parked effect by replying, checked by plain code`.

---

### Task 7: Docs, decisions and the spec amendment

**Files:**
- Create `docs/decisions/0017-sources.md`. It covers:
  - sources as system-level senders;
  - the generated handlers;
  - the status codes;
  - ids from delivery ids;
  - why actors never subscribe.
- Create `docs/decisions/0021-approvals-by-email-reply.md`. It covers:
  - reply, never link;
  - the subject token, and why it replaces the SDK's header resolver for human replies;
  - the plain-code parse;
  - owner and authentication rules;
  - the publishes guard.
- Modify `docs/architecture.md` (its decision table links 0017 and 0021; `g7.docs` checks this).
- Modify `docs/wiki/Runtime.md`. Add a "Sources" section and rows for:
  - verified, deduplicated webhook delivery;
  - email approval rules;
  - one notification per parked approval.
- Modify `docs/wiki/Limitations.md`. Add:
  - GitHub doesn't redeliver failures, so `source.invalid` and `source.failed` records are how a missed event is found;
  - email authentication may be unknown until spike 6, with the publishes rule.
- Modify the spec, §8.2 and §4 "Email": amend the reply-matching mechanism, citing the design correction at the top of this plan and decision 0021.

**Steps:**
- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run)` and `node --test tests/*.test.mjs` at the repository root.** Expected: exit 0. These include the docs-link checks.
- [ ] **Step 3: Commit.** Message: `Decisions 0017 and 0021; Runtime and Limitations document sources and email approvals`.

---

### Task 8: Spike 6, real email (owner-assisted)

This task needs the owner. The owner provides a Cloudflare domain and the address that approvals go to. The owner runs every deploy, secret and routing command with `!`, because the repo's permission rules deny them to agents. The owner also replies to one email from Gmail.

The implementer prepares everything, waits for the owner's actions, then reads the results.

**Files:**
- Create `spikes/email-approval/`, containing `wrangler.jsonc`, `src/index.ts`, `package.json` and `README.md`.
  - It's a one-actor system with an approval effect, the `mail` email source, and the `approvalEmail` adapter.
  - Its `email()` handler stores the full inbound headers of each received message into the actor's SQLite before calling `handleEmail`.
  - `GET /spike` returns those stored headers and the approval outcome.
  - `POST /spike/ask` parks an approval.
- Create `docs/evidence/spike-6-email.md`.

**Steps:**
- [ ] **Step 1: Prepare the spike.** Write the spike, and write `README.md`, which lists the owner's exact commands in order:
  - `! npx wrangler login`, if needed;
  - enable Email Routing on the domain and add a routing rule from the approval address to the Worker (dashboard steps, or `! cf …` equivalents);
  - `! npx wrangler secret put SPIKE_APPROVAL_SECRET`;
  - `! npx wrangler deploy`, from `spikes/email-approval`;
  - `! curl -X POST https://<worker>/spike/ask`.

  Commit the spike: `Spike 6: an email-approval Worker for a real Gmail round trip`.
- [ ] **Step 2: Stop and ask the owner.** Ask them to run the README's commands, then to reply "approve" from Gmail to the email that arrives. Wait for confirmation.
- [ ] **Step 3: Read the results.** Run `curl https://<worker>/spike`, which is a read. Record in `docs/evidence/spike-6-email.md`:
  - whether the subject token survived the reply;
  - the `Authentication-Results` header verbatim, if any;
  - whether DKIM/DMARC results were visible;
  - the `In-Reply-To` header;
  - whether the `send_email` binding let the spike set `Message-ID`;
  - the delivered decision and the effect's outcome.
- [ ] **Step 4: Settle the open rule.**
  - **If `dmarc=pass` was visible:** record it. Note in `Limitations.md` that authenticated email can approve publishing effects; the code already allows it.
  - **If not:** the publishes guard stays as the owner decided. Record that in `Limitations.md` and in decision 0021.
  - **If the subject token did not survive Gmail's reply:** stop and report BLOCKED with the evidence. The transport needs a design decision.
- [ ] **Step 5: Commit.** Message: `Spike 6 evidence: a real Gmail reply approves a parked effect`, stating the actual result.

---

### Task 9: Full verification

- [ ] **Step 1: Verify from a plain clone.**
  - Clone the final commit into a fresh scratch directory: `npm ci`, `npm run build -w @actord/toolkit`, `npm run verify`.
  - Every gate must `pass`; `blocked` is allowed only for a missing prerequisite.
  - In the clone, confirm that after the build `git status --short` shows only verify's outputs.
- [ ] **Step 2: Commit the outputs in the worktree.**
  - Copy `verify-report.json`, `docs/verification-report.md` and the `docs/evidence/` files that verify rewrote back into the worktree.
  - Update `docs/progress.md`: plan 2 delivered; plan 3 is next.
  - Commit: `Verification for plan 2 (sources and email approvals): <N> pass, <F> fail, <B> blocked`.
