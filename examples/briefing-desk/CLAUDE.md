# briefing-desk

An actor system on Cloudflare Durable Objects, built with actors-toolkit.
- The declaration is `system.ts` (actors, messages, routes, effects). Actors live in `src/actors/`, contracts in `src/messages/`.
- `npx actors check` validates what the compiler can't; `npx actors graph` prints the topology.
- `npm test` runs workerd tests and records events in `.actors/events.ndjson`; `npx actors trace <id>` explains one.
- `npm run verify` runs everything and writes `.actors/evidence.json`. Run it before committing.
- Deploys need a person's approval; never run `wrangler deploy` unasked.
