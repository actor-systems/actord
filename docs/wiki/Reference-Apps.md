# Reference applications

| App | What it demonstrates | Tests (workerd) |
| --- | --- | --- |
| [`examples/release-radar`](https://github.com/actor-systems/actord/blob/main/examples/release-radar) | Deterministic-first: a scheduled poller (one actor per feed), a state-owning ledger that deduplicates and classifies by rule, a digest writer that notifies once per finding | 22, across duplicates, crashes before and after writes, eviction, retry exhaustion, ordering, schedule, lost acknowledgment |
| [`examples/briefing-desk`](https://github.com/actor-systems/actord/blob/main/examples/briefing-desk) | Judgment-capable: intake, a model-assisted analyst per item (bounded budget, validated model output, cancellation while the model call is in flight), and human approval before a briefing leaves through a gateway with no idempotency key | 11, across reentrancy, model unavailable or slow, invalid model output, approval, denial, in-doubt delivery |

Each app states its reliability claims in `actord.claims.json`: what is proved locally in workerd, what is
shown only against a stub of an external system, and what is deliberately not guaranteed. Every claimed
property must have a passing tagged test (`npm run verify` enforces this). Neither app needs a model API
key: tests use deterministic doubles, and Briefing Desk's live Anthropic adapter is optional.
