# briefing-desk

An actor system on Cloudflare Durable Objects, built with @actord/toolkit.
- The declaration is `system.ts` (actors, messages, routes, effects). Actors live in `src/actors/`, contracts in `src/messages/`.
- `npx actord check` validates what the compiler can't; `npx actord graph` prints the topology.
- `npm test` runs workerd tests and records events in `.actord/events.ndjson`; `npx actord trace <id>` explains one.
- `npm run verify` runs everything and writes `.actord/evidence.json`. Run it before committing.
- When adding behavior, keep public read methods (names and return shapes) and existing tests as they are; prove the change with a new test.
- Deploys need a person's approval. Asked to deploy, give the plan from `npx actord diff`; never run `wrangler deploy` unasked.
- Write and change files with the Write and Edit tools, not shell redirection or heredocs.
