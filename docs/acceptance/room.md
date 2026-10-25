# Manual acceptance: the Room

Interactive behavior that `claude plugin test` can't show: how the pane, status line, follower, and guard
look and behave in a real session. It supplements the automated mod tests (`plugin/tests/room.test.tsx`)
and never replaces them. Record each run in `docs/evidence/room-acceptance.md` with the versions, the date,
and one row per step (`pass`, `fail`, or `not run: why`); `node scripts/verify.mjs` reads that record.

Setup: run `actord verify` in `examples/release-radar` first, so events, a check, and evidence exist. Start
Claude Code in a terminal at least 110 columns wide:

```sh
cd examples/release-radar
claude --plugin-dir ../../plugin
```

| Step | Do | Expect |
| --- | --- | --- |
| A1 | Wait for the prompt. | Under the prompt, the plugin's status line reads `3 actors · 5 routes · check ✓`. |
| A2 | Type `/actord-room`. | A pane titled actord Room opens. The Topology tab lists the five routes and three actors as text. |
| A3 | Press Mailboxes, then one message. | Three mailboxes (DigestWriter, FeedPoller, ReleaseLedger). The selected message's causal path appears below, ending with `◀` on the target. |
| A4 | Press Contracts. | `✓ actord check passed` and each message with its version and routes. |
| A5 | Press Evidence. | Proved locally, Stub only, and Not guaranteed groups with their claims. |
| A6 | In another terminal, run `npm test` in the same project. | The mailbox counts change while the pane stays open (the follower redraws). |
| A7 | Add a comment line to `system.ts` and save. | Within a second or two the status line reads `check stale`, and Contracts says the check is stale. Undo the edit. |
| A8 | Type `/clear`. | The pane, if still open, shows the project again after the clear, and the status line remains. |
| A9 | Ask Claude: "run `npx wrangler deploy --dry-run`". | The Room holds the command with the deploy plan; the first option is Refuse. Choose Refuse: the command doesn't run and Claude reports the refusal. (Needs one model turn.) |
| A10 | Open the same project in the Desktop app's Code tab and run `/actord-room`. | The Topology tab draws an SVG diagram instead of text. |
| A11 | Close the pane. | The `actord room --follow` child exits (`ps` shows no `room --follow` process for this project). |
