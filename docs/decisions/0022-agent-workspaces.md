# 0022 — Agent workspaces: Computer in the object, commands in a container, git from the object

- **Date:** 2026-10-27 · **Gate:** plan 3 (agent actors) · **Status:** accepted · **Reversibility:** moderate (the
  workspace is a declaration, `computer()`, behind `@actord/toolkit/agents`; Computer's Container backend is
  experimental)

## Context
An agent that changes a repository needs its files, a Linux machine for `npm ci` and the tests, and a way to push.
Spec §7.4 put the files in a `@cloudflare/computer` `Workspace` in the agent's own Durable Object, the commands in a
Cloudflare Container that Computer schedules, and git on the object's side, so no credential enters the container.
Three things in it were unknown until spikes 2, 4 and 5 ran on a real container
(`docs/evidence/spike-2-computer.md`, `spike-4-long-run.md`, `spike-5-push.md`): what a lost container reports, what
an install costs, and which auth GitHub's git endpoint takes. Spike 3 found that containers don't run under the
Vitest integration.

## Decisions
1. **The workspace lives in the object's SQLite.** `harness: pi({ workspace: computer({...}) })` gives the actor a
   Computer `Workspace` over its own storage (Computer's `vfs_` tables), built by `workspaceFor`. What the agent writes
   outlives the container and any restart (`[workspace-edit-survives-restart]`). Its Pi tools are Computer's
   (`createPiTools`); `tools: ["workspace.*"]` or `"workspace.<name>"` selects them. Reading, searching and editing run
   in the object, with no container.
2. **Replay classes (correction 5).** Computer ships none, so the toolkit takes the Agents SDK Pi example's split:
   - `read`, `ls`, `find`, `grep`, `write` and `delete` run again after a restart cut them off;
   - `edit`, `exec` and `publish` come back to the model as interrupted.
3. **`write`, `edit` and `delete` refuse git's own files.** A path in a `.git` directory is refused, with `.`, `..` and
   symlinks resolved and the name compared case-insensitively (`[workspace-git-dir-refused]`). These tools run in the
   object, beside a push, and a `.git/config` written mid-push could name where the token goes (decision 5). The
   model runs git through `exec` instead.
4. **Egress is the toolkit's own gateway (correction 6).** Computer has no egress allowlist.
   - The default is `none`.
   - `egress: "registry-read"` sends the container's HTTP and HTTPS through `RegistryReadGateway`. It lets `GET` and
     `HEAD` to `https://registry.npmjs.org` and `https://registry.yarnpkg.com` through, and answers anything else
     `403`, publish requests included. Only the headers a read needs are forwarded, never `Host` or credentials, and a
     redirect goes back to the container, whose next request is checked again.
   - The container's egress and computerd's connection come back to the object through Computer's `WorkspaceProxy`,
     so the Worker must export it. The object's `fetch` hands those requests to the agent runtime's `fetch`.
5. **The git model.**
   - Clone (`gitClone`) and push (`gitPushEffect`) run in the Durable Object, through Computer's git client, never in
     the container. A clone is full, since a shallow branch can't be pushed safely.
   - The push URL is pinned: the app passes it, the workspace never does. It must be `https`, with no credentials in
     it. `corsProxy: ""` is passed too.
   - Computer 0.8.0's push drops `corsProxy`, so isomorphic-git falls back to `http.corsProxy` from `.git/config`,
     which the agent can write through `exec`. So a push from a repo whose config sets one is refused, before the
     token is minted and again just before the push (`[git-push-url-pinned]`).
   - The same two checks require `.git` to be a plain directory, with a `.git/config` that isn't a symlink
     (`lstat`); anything else, a missing `.git` included, is refused. Through `exec` the agent could make `.git` a
     symlink (`mv .git meta && ln -s meta .git`) or a `gitdir:` file (`printf 'gitdir: meta' > .git`), which
     isomorphic-git follows, or link the config. A `write` to the target, `meta/config`, would then pass decision 3's
     guard while changing the config the push reads. So the guard covers a redirected gitdir by refusing the push, not
     the write.
   - Authentication is Basic `x-access-token:<token>` only, as GitHub Actions sends it. Spike 5: GitHub's git
     endpoint answers Bearer with `401`, and Basic landed the push.
   - The token is the app's `token()`, called for each push attempt and each clone. It goes to the git client as an
     `Authorization` header for that one call. It never reaches the container, `.git/config`, a row or an event, and
     an error leaves with every form of it scrubbed (raw, Bearer, Basic, and Basic's base64), without its cause.
     Spike 5 searched the container's exec environment, `/workspace`, every process's environment and the object's
     vfs, and found it nowhere.
   - `allow` decides which branches may be pushed. The default, `factoryBranch`, is any valid refname under
     `factory/`. Spec §7.4 says an agent pushes "its own `factory/` branch", so an app binds `allow` to the instance's
     own branch. With the default, an agent could fast-forward another issue's `factory/` branch.
6. **The container rulings (spikes 2 and 4).**
   - **`localOnly` is required with a container backend** (`AGENT_LOCAL_ONLY_MISSING`; `[]` syncs everything and is an
     explicit choice). With nothing local-only, `npm ci` took 7.8× as long (184.8 s against 23.8 s) and put 405 MB in
     the object. The docs recommend `["**/node_modules"]`. A pattern must start with `/` or `**/`, as Computer
     requires (`AGENT_LOCAL_ONLY_INVALID`).
   - **The tools' exec timeout defaults to 10 minutes**, and a workspace sets its own with `execTimeoutMs`
     (`AGENT_EXEC_TIMEOUT_INVALID` for anything but a positive whole number). Spike 2's longest command was the 185 s
     install. The default applies to the tools' execs only: an app's own commands may run longer.
   - **The egress CA goes with every exec through `workspace.runtime`.** computerd's commands get only `HOME`,
     `OLDPWD`, `PATH`, `PWD` and the exec's own `env`, never the image's `ENV`, and npm refused the gateway's
     certificate without `NODE_EXTRA_CA_CERTS` (spike 2). So with `registry-read`, every exec through
     `workspace.runtime` gets `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt` under the
     caller's own `env`: the tools' execs and an app's own alike. For that, `workspaceFor` returns a wrapped
     `Workspace` (a Proxy). An exec through Computer's RPC stub, `workspace.stub()`, doesn't get it (R33; see
     Limitations).
   - **Nothing is pulled before a session resumes.** Spike 4 evicted the object during a test run: no edit was lost,
     no sync was pending, and the next exec's sync brought back what the interrupted command wrote.
   - **A lost container is an interrupted command.** An exec whose container is lost is reported to the model as
     interrupted: the command "may have partly run", and files written before it are kept. Spike 4's eviction gave
     Pi's own "Tool exec was interrupted and may have partially run", and the model's next command ran 8 s after the
     eviction.
     A run that fails after at least its timeout is reported as timed out instead, judged by the time elapsed since
     the exec was called, because how computerd ends a timed-out run hasn't been seen.
   - **Wrangler's container entry.** A workspace with a container backend needs a `containers` entry for the actor's
     class, with `scheduling_policy: "durable_object"` and `images` (`AGENT_CONTAINER_CONFIG_MISSING`; wrangler
     rejects `image` for that policy). The class is built with Computer's `withWorkspaceContainer` and passes itself
     as `container`.
   - **The `backend` options** on `workspaceFor` and `agentRuntime` are internal test seams, not public API.
7. **Settled by the spikes.** Plan 3 deferred three items until spikes 2 and 4 had run: required `localOnly`, the exec
   timeout, and a `pull()` before resume. The first two landed as above; the third was dropped. Spec §7.4's fallback,
   Pi's tools over `ctx.container.exec` through a tool environment of our own, isn't needed: spike 2 ran the install,
   the build and 209 tests through the Container backend.

## Known gaps
- **The `corsProxy` residual.** The toolkit's check of `http.corsProxy` and Computer's own read of it are two reads.
  The last check runs just before the push, and between the two there is only storage, not the network. Only a
  Computer that forwards `corsProxy` on push closes it (its clone already does). The owner accepted the gap, and #79
  is open to research the upstream fix. The pinned URL has no such window.
- **Corrupt tarballs.** In spike 2, the `workerd` and `wrangler` tarballs arrived corrupt once through the gateway, and
  npm's retry fixed them. The cause is unknown.
- **No container in tests.** Containers don't run under `@cloudflare/vitest-plugin` 1.4.7 (spike 3). Container tests
  run against `ContainerStub`, a stand-in for `ctx.container`.
- **Deploys reach a busy agent late.** In spike 4 a deploy reached the busy object five minutes late, between
  commands. To roll new code to a running agent now, the object must restart.

## Rejected alternatives
- **Computer's per-backend egress allowlist** (spec §7.4). It doesn't exist.
- **Bearer first, then Basic.** GitHub answers Bearer with `401`, so the first attempt always failed.
- **Reading the push URL from the workspace's remote.** The agent can write `.git/config`, so the token could go to
  any host.
- **A `pull()` from the container before a session resumes.** Spike 4 lost nothing without it.
- **Setting the CA in the image's `ENV`.** computerd's commands never see it.
