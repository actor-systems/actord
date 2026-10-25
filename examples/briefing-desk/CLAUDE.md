# briefing-desk

An actor system on Cloudflare Durable Objects, built with @actord/toolkit.
- The declaration is `system.ts` (actors, messages, routes, effects). Actors live in `src/actors/`, contracts in `src/messages/`.
- `npx actord check` validates what the compiler can't; `npx actord graph` prints the topology.
- `npm test` runs workerd tests and records events in `.actord/events.ndjson`; `npx actord trace <id>` explains one.
- `npm run verify` runs everything and writes `.actord/evidence.json`. Run it before committing.
- Deploys need a person's approval; never run `wrangler deploy` unasked.
