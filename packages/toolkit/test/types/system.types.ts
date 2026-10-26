// Compile-time contract tests: `tsc --noEmit` fails if any @ts-expect-error stops being an error.
import { z } from "zod";
import { defineSystem, message, type MessagesFrom, type MessagesTo, type PayloadIn } from "../../src/system.ts";

const Observed = message({ version: 1, description: "A feed item was seen", payload: z.object({ id: z.string(), title: z.string() }) });
const Classified = message({ version: 1, description: "An item was classified", payload: z.object({ id: z.string(), severity: z.enum(["minor", "major"]) }) });

const system = defineSystem({
  name: "types-ok",
  messages: { "release.observed": Observed, "release.classified": Classified },
  actors: {
    Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"] },
    Ledger: { binding: "LEDGER", kind: "deterministic", purpose: "dedupes", justification: ["state"] },
  },
  routes: [
    { from: "Poller", message: "release.observed", to: "Ledger" },
    { from: "Ledger", message: "release.classified", to: "Poller" },
  ],
});

const ledgerReceives: MessagesTo<typeof system, "Ledger"> = "release.observed";
// @ts-expect-error Ledger does not receive release.classified
const wrongReceive: MessagesTo<typeof system, "Ledger"> = "release.classified";
const pollerSends: MessagesFrom<typeof system, "Poller"> = "release.observed";
const payload: PayloadIn<typeof system, "release.classified"> = { id: "a", severity: "major" };
// @ts-expect-error severity must be one of the declared values
const badPayload: PayloadIn<typeof system, "release.classified"> = { id: "a", severity: "huge" };

defineSystem({
  name: "unknown-actor",
  messages: { "release.observed": Observed },
  actors: { Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"] } },
  // @ts-expect-error Ghost is not a declared actor
  routes: [{ from: "Poller", message: "release.observed", to: "Ghost" }],
});

defineSystem({
  name: "unknown-message",
  messages: { "release.observed": Observed },
  actors: { Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"] } },
  // @ts-expect-error release.vanished is not a declared message
  routes: [{ from: "@ingress", message: "release.vanished", to: "Poller" }],
});

defineSystem({
  name: "unknown-effect",
  messages: { "release.observed": Observed },
  actors: {
    // @ts-expect-error notify.pager is not a declared effect
    Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"], effects: ["notify.pager"] },
  },
  effects: { "notify.digest": { description: "digest", idempotency: "key" } },
  routes: [{ from: "@ingress", message: "release.observed", to: "Poller" }],
});

defineSystem({
  name: "unknown-schedule-message",
  messages: { "release.observed": Observed },
  actors: {
    // @ts-expect-error poll.due is not a declared message
    Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"], schedules: [{ every: "5m", message: "poll.due" }] },
  },
  routes: [{ from: "@ingress", message: "release.observed", to: "Poller" }],
});

defineSystem({
  name: "effects-ok",
  messages: { "release.observed": Observed },
  actors: {
    Poller: { binding: "POLLER", kind: "deterministic", purpose: "polls", justification: ["scheduling"], effects: ["notify.digest"], schedules: [{ every: "5m", message: "release.observed" }] },
  },
  effects: { "notify.digest": { description: "digest", idempotency: "key" } },
  routes: [{ from: "@clock", message: "release.observed", to: "Poller" }],
});

export { ledgerReceives, wrongReceive, pollerSends, payload, badPayload };
