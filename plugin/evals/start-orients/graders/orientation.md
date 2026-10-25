---
type: llm
---

PASS if the reply does all three: (1) says the toolkit helps build actor systems on Cloudflare Durable Objects with a typed declaration (system.ts), a CLI that checks and inspects it, and tests run in Cloudflare's runtime; (2) reports at least one concrete finding from `actors doctor` (such as the Node.js version or that no project exists yet), or says plainly that the doctor couldn't run; (3) offers one concrete next step.
FAIL if any of the three is missing, or if the reply claims to have created a project, written files, or deployed anything.
