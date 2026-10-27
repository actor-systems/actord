# Spike 2: Pi in a Computer workspace on a real Cloudflare Container

**Run:** 2026-10-27, 19:15–20:30 UTC, on the `spike-agent-workspace` Worker (Workers Paid).
- **Software:** wrangler 4.152.0, `@cloudflare/computer` 0.8.0.
- **The image:** `sha256:ed7f6f6d…`: Debian, Node 24.22.1, npm 11.19.1, git, and computerd 0.8.0.
- **The container:** `standard-2` (1 vCPU, 6 GiB, 12 GB disk), kernel `6.18.54-cloudflare-microvm`.
- **The repository:** `actor-systems/actord` at `caf9430`.

**Setup:**
- **The object.** One Durable Object, `Bench`, holds a Computer `Workspace` in its SQLite. The workspace's one backend
  is a `ContainerBackend`.
- **Local-only paths.** `**/node_modules` and `/dist` are local-only (Computer's `ignore`) unless a step says otherwise.
- **Egress.** It runs in `http-gateway` mode. The object's gateway lets through `GET` and `HEAD` to
  `registry.npmjs.org` during an install, and refuses everything else.
- **Pi.** A `PiHarness` on Workers AI's `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, with Computer's Pi tools on the
  workspace.
- **The code.** `spikes/agent-workspace/src/index.ts`, run with the steps in `spikes/agent-workspace/README.md`. The raw
  job records come from the Worker's `GET /report`.

## Results

| Question | Observed | Result |
| --- | --- | --- |
| Clone | 1.5 s, on the object's side through Computer's git client. 3,354 objects, 876 working-tree entries. The object's SQLite then held 13.1 MB: 12.4 MB of files, as 533 blobs. | pass |
| Container start | The first connect took 12 s. Later connects to the running container took 3 to 325 ms. The relaunch in step 14 took 3.1 s. | — |
| `npm ci`, `node_modules` local-only | **23.8 s**, exit 0. 434 MB of `node_modules` on the container's disk. The object's SQLite grew 32 KB, and no `node_modules` directory reached `vfs_dirents`. The gateway let through 248 `GET`s to `registry.npmjs.org` and refused none. | **pass** (third try; see below) |
| `npm ci`, nothing local-only (step 14) | **184.8 s**, exit 0, **7.8× slower**. The object's SQLite grew **405 MB** (19,951 files, 542 MB of file bytes stored as 387 MB of blobs). | pass, slow |
| Anything like computer#179? | No. The 405 MB sync didn't time out, and the object didn't reset (`resetBy: null`) in step 14. | **no** |
| Do the tests pass in the container? | The build took 2.8 s, then **209 of 209** tests passed in 22.7 s. The first try failed 39 tests, because a fresh clone has no build; see below. | **pass** |
| Does the model's edit show in `git diff`? | `/prompt` took 14.4 s: 6 model responses, $0.0027. Pi added the line with `read` and `edit`, then ran `git diff` with `exec`. The line was in the container's `git diff` and in the object's own diff. | **pass** |
| What does a running command report when its container is destroyed? | `POST /stop?force=1` ran 6 s into `npm test`. The exec's result rejected in the same second with `WritableStream RPC stub was disposed without calling close()`. There was no reconnect wait. | the toolkit's handling holds; see below |

### The egress certificate: commands don't get the image's `ENV`

- **The failures.** The first two installs failed with `SELF_SIGNED_CERT_IN_CHAIN`, and the gateway saw no request. npm
  didn't trust the HTTPS intercept's certificate authority, even though the image's `ENV` sets `NODE_EXTRA_CA_CERTS` to
  it.
- **The cause.** The probe printed `inherited NODE_EXTRA_CA_CERTS=unset`. A command computerd runs gets only `HOME`,
  `OLDPWD`, `PATH`, `PWD` and the exec's own `env`. Spike 5's `env` search showed the same list. So none of the image's
  `ENV` reaches a command: `NODE_EXTRA_CA_CERTS`, `GIT_OPTIONAL_LOCKS` and the `npm_config_*` settings included.
- **The fix.** The spike sets `NODE_EXTRA_CA_CERTS` on `npm ci` itself (`9674e7d`). Cloudflare's own sandbox guide says
  the same: "pass `ENV` to each `exec()` call".
- **The first try at the fix.** The fix's first try ran the old code. A running object keeps its version through
  deploys and secret changes until it restarts, which is spike 4's subject. `/evict` booted the new version.

Ruling: when a workspace's egress is `registry-read`, the toolkit's exec passes `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt` in every exec's `env`, merged under the caller's, because computerd's commands never see the image's `ENV`, and an install through the gateway fails without it — cost if wrong: a non-Node client in the container (curl, pip) still distrusts the gateway until the image adds the certificate to the system bundle, which needs a start command, not `ENV`.

### Corrupt tarballs through the gateway

- **What happened.** In the successful local-only install, the `workerd` and `wrangler` tarballs arrived corrupt on the
  first try. npm said "zlib: invalid distance too far back", then "seems to be corrupted. Trying again". The retries
  passed.
- **Where.** Both are among the largest packages. The cause is unknown: it could be the gateway's streaming or the
  intercept.
- **The 405 MB install.** It printed no such warning.

Not settled here. If it happens again, a registry-read gateway may need to buffer a tarball before answering.

### Install scripts

npm 11's `allowScripts` skipped the install scripts of `esbuild`, `workerd` and `core-js-pure`. The build and every test
passed without them.

### Fresh clones need a build before the tests

- **The failure.** The first `/test` failed 39 tests, all because `node_modules/@actord/toolkit/dist/system.mjs` didn't
  exist. A fresh clone has no build. This is the known gap that plan 3 deferred to Task 11.
- **The fix.** `/test` now runs `npm run build -w @actord/toolkit` first, as CI does (`09d85a8`).

### A lost container

- **How the toolkit marks it.** The toolkit's exec wrapper (`withLostContainers` in
  `packages/toolkit/src/agents/workspace.ts`) treats any rejection of an exec's result as a lost container. It tells the
  model the command "may have partly run".
- **This run's shape.** A result that rejects at once, with an RPC-disposal message. That fits the wrapper.
- **The start path.** It matches transport failures by name and message, and isn't affected: the loss here came after
  the start.

Ruling: a workspace with a container backend must declare `localOnly` (a check error when it's missing; `[]` is an explicit choice), because syncing `node_modules` made `npm ci` 7.8× slower and put 405 MB into the object's SQLite. The docs recommend `["**/node_modules"]` — cost if wrong: one more line in every container workspace's declaration.

Ruling: the exec tool's default timeout is 10 minutes, overridable per workspace, because the longest command here was the 185 s install with nothing local-only and test runs took 23 to 25 s — cost if wrong: a longer build must raise it.

## Not checked here

- **A refused request.** The gateway refused nothing during these runs. Its refusals are covered by the toolkit's
  `RegistryReadGateway` tests, not here.
- **Other images.** Only this one, `standard-2` and one region were tried.
