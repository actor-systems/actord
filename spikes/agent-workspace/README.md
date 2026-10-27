# Spikes 2, 4 and 5: an agent workspace on a real container

**Spike 2** puts Pi to work on the actord repository in a Computer workspace whose backend is a real Cloudflare
Container, and measures:
- how long `npm ci` takes, with `node_modules` local-only and without;
- how many bytes the workspace syncs into the Durable Object;
- whether anything like computer issue #179 happens (an install timeout, then a storage timeout that resets the
  object);
- whether the tests pass in the container, and whether the model's edit shows in `git diff`.

**Spike 4** gives Pi a long task, up to 45 minutes. It redeploys the Worker during a running command about 10 minutes
in, and evicts the object about 20 minutes in. For each disruption it asks:
- whether the command came back interrupted or ran again;
- whether a workspace edit was lost;
- whether pi resumed by itself, and how long the gap was;
- whether a sync was left pending.

**Spike 5** pushes a `factory/` branch from the Durable Object with a GitHub App installation token passed to the git
client as a header. It then searches the container for the token.

## What it is

There is one Durable Object, `Bench`, with one instance, `main`, so there is one container at most. `Bench` holds:
- a Computer `Workspace` in its SQLite, whose one backend is a `ContainerBackend` (`standard-2`: 1 vCPU, 6 GiB, 12 GB
  disk). The object starts the container itself. `**/node_modules` and `/dist` are local-only: they stay on the
  container's disk and are never synced;
- a `PiHarness` on Workers AI's DeepSeek V4.1 Flash (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`), with Computer's Pi
  tools (`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, `exec`) on that workspace.

**Records.** Each endpoint runs one job, one at a time, recorded in the object's SQLite. Each job records:
- its wall time and status;
- the `vfs_*` sizes before and after, that is, what was synced into the object;
- whether a `node_modules` directory reached `vfs_dirents`;
- whether the object was reset while the job ran (computer#179). The next boot closes such a job as `interrupted`.

Each container command is an exec, recorded with its exit code, sync status and output tails.

**Egress.** The container has no direct network.
- Its outbound HTTP and HTTPS goes through a gateway in `Bench`. While an install runs, the gateway lets through `GET`
  and `HEAD` to `registry.npmjs.org`. It refuses everything else, and everything outside an install.
- Every request it sees is recorded, allowed or not.
- The backend runs in Computer's `http-gateway` mode rather than `none`, because the install needs the registry. The
  mode is fixed when the container starts, and an intercept can't be removed from a running container. So "no network"
  is the gateway refusing everything.

**Cost guards.**
- There is one container at most.
- The watchdog destroys the container after 20 minutes without a job.
- `/prompt` gets at most 15 model responses and 10 minutes, and no prompt starts once the model spend reaches $8.
- `/long` is stopped at 45 minutes, $5 of model spend or 200 model responses, whichever comes first.
- Model commands time out after 10 minutes, the install after 20 and the tests after 15.

**Endpoints.** Every endpoint needs `Authorization: Bearer <SPIKE_TOKEN>`; anything else gets `401`.
- **Streaming.** The `POST`s stream NDJSON: a `{"waiting":<seconds>}` line every 15 seconds, then the job's record.
- **Dropped connections.** If the connection drops, the job keeps running. `GET /report` has it.
- **Concurrency.** A second job while one runs is refused.

| Request | What it does |
| --- | --- |
| `POST /clone[?fresh=1]` | A full clone of `https://github.com/actor-systems/actord` (its default branch) into `/workspace/actord`, on the object's side through Computer's git client |
| `POST /install[?ignore=off]` | `npm ci` in the container. `ignore=off` syncs `node_modules` too. It is one way: run it last |
| `POST /test` | `npm test -w @actord/toolkit` |
| `POST /prompt` | Pi adds one fixed line to `docs/progress.md` with the workspace tools, then runs `git diff`. The spike checks the diff on both sides |
| `POST /push` | Spike 5: mint an installation token in the object, push `factory/spike-5`, search the container for the token, revoke the token |
| `POST /long` | Spike 4: start the long task and return at once. See [Spike 4](#spike-4-the-long-run) |
| `POST /evict[?during=exec]` | Spike 4: `ctx.abort()`. With `during=exec`, it first waits, up to 5 minutes, for a command to be running |
| `POST /stop[?force=1]` | Destroy the container. Refused while a job runs, unless forced |
| `GET /status` | The running job and exec, if any |
| `GET /report` | Everything recorded: boots (with the version each ran), jobs, execs with their sync status, egress, events, `vfs_*` sizes, sync operations, Computer's execution runtimes, the long run's snapshots, and pi's usage, diagnostics, submissions, tasks, interrupted tool calls and transcript |

`call.sh METHOD PATH` calls the deployed Worker. It reads the token and the URL from the git-ignored `.spike-token` and
`.deploy.log`.

## Before you start: what was checked (read-only, 2026-10-27)

- **The model id.** `@cf/deepseek-ai/deepseek-v4.1-flash-1017` is on Cloudflare's model page and pricing page:
  - $0.30 per million input tokens, $0.006 per million cached input tokens, and $1.20 per million output tokens;
  - a 20 requests a minute limit;
  - Workers Paid is required.

  pi-ai 1.4.0's catalog has the model with the same prices, so pi's own cost figures should match.
- **The image.** `ghcr.io/cloudflare/computer-computerd-linux-x64:0.8.0` exists (GHCR answered 200 for the tag).
- **Docker.** `wrangler deploy` builds the image locally, so Docker must be running. Docker 29.9.2 is installed here.
- **Reasoning level.** It can't be lowered.
  - The catalog maps only `high` and `max` for this model, so pi raises a lower level to `high`.
  - `createAI`'s settings don't take `reasoningEffort`.
  - pi drops per-model options.

  Expect the model's default reasoning. The report's `pi.diagnostics` shows what the wire did.
- **The repository.** It is public, so the clone needs no credentials.

## The GitHub App (spike 5)

Create it under the `actor-systems` organization. Your own account works too: use
https://github.com/settings/apps/new instead, and your account wherever these steps say the organization.

1. Open https://github.com/organizations/actor-systems/settings/apps/new.
2. **GitHub App name:** something unique, such as `actord-spike-5`. **Homepage URL:**
   `https://github.com/actor-systems/actord`.
3. **Identifying and authorizing users:** leave it empty. **Post installation:** leave it empty.
4. **Webhook:** uncheck **Active**.
5. **Permissions → Repository permissions → Contents:** **Read and write**. **Metadata** becomes **Read-only** by itself.
   Leave every other permission at **No access**.
6. **Where can this GitHub App be installed?** **Only on this account.** Then press **Create GitHub App**.
7. On the App's **General** page, note the **App ID**, a number under **About**.
8. On the same page, under **Private keys**, press **Generate a private key**. A `.pem` file downloads, such as
   `~/Downloads/actord-spike-5.2026-10-28.private-key.pem`.
   - Leave it as it is: it is PKCS#1 (`BEGIN RSA PRIVATE KEY`), and the Worker converts it to the PKCS#8 that WebCrypto
     needs. Both forms were checked locally.
   - Don't move it into the repository.
9. In the left sidebar press **Install App**, then **Install** next to `actor-systems`.
   - Choose **Only select repositories**, then `actor-systems/actord`, then **Install**.
   - The page you land on is `https://github.com/organizations/actor-systems/settings/installations/<number>`. That
     number is the **Installation ID**.

## The owner's commands, in order

Run them from the repository root. Each line is typed into Claude Code with `!`. If a wrangler command says you're not
logged in, run `! npx wrangler login` first.

**Copy the commands exactly.**
- Paths with a query string are in single quotes, because zsh treats an unquoted `?` as a glob and refuses the command
  ("no matches found").
- Placeholders such as `'<APP_ID>'` are quoted too. Replace the text between the quotes and keep the quotes.

1. **Check that Docker is running.** It should print a version, not an error:

   ```
   ! docker info --format '{{.ServerVersion}}'
   ```

2. **Generate the bearer token** into the git-ignored `.spike-token`:

   ```
   ! openssl rand -hex 32 > spikes/agent-workspace/.spike-token
   ```

3. **Deploy.** This builds the container image with Docker (linux/amd64; under emulation on Apple Silicon, the first
   build takes several minutes), pushes it to Cloudflare's registry, and deploys the Worker. The URL it prints is also
   saved to the git-ignored `.deploy.log`.

   ```
   ! npx wrangler deploy -c spikes/agent-workspace/wrangler.jsonc 2>&1 | tee spikes/agent-workspace/.deploy.log
   ```

   The deploy comes before the secrets on purpose: `wrangler secret put` for a Worker that doesn't exist yet asks a
   question, and with input from a file it can't be answered. Until the bearer token is set, every request gets `401`.

4. **Set the four secrets.**
   - Replace `<APP_ID>` and `<INSTALLATION_ID>` with the numbers from the App's steps 7 and 9, and the `.pem` path with
     the file GitHub downloaded.
   - The key goes in from the file, so it is never printed.

   ```
   ! npx wrangler secret put SPIKE_TOKEN -c spikes/agent-workspace/wrangler.jsonc < spikes/agent-workspace/.spike-token
   ! printf '%s' '<APP_ID>' | npx wrangler secret put GITHUB_APP_ID -c spikes/agent-workspace/wrangler.jsonc
   ! printf '%s' '<INSTALLATION_ID>' | npx wrangler secret put GITHUB_APP_INSTALLATION_ID -c spikes/agent-workspace/wrangler.jsonc
   ! npx wrangler secret put GITHUB_APP_PRIVATE_KEY -c spikes/agent-workspace/wrangler.jsonc < ~/Downloads/actord-spike-5.2026-10-28.private-key.pem
   ```

5. **Clone.** This needs no container, and takes seconds. The last line is the job's record; `detail.head` is the
   commit cloned.

   ```
   ! spikes/agent-workspace/call.sh POST /clone
   ```

6. **Install.** After a first deploy, Cloudflare may take a few minutes to provision the image. If this fails at the
   container's start, wait five minutes and run it again.
   - This starts the container and runs `npm ci` with `node_modules` local-only, which takes a few minutes.
   - In the record, look at `detail.exitCode` and `detail.installMs`. `nodeModulesInVfs` should be `false`.

   ```
   ! spikes/agent-workspace/call.sh POST /install
   ```

7. **Test.** In the record, `detail.tests` is vitest's summary line.
   - `node_modules` is local-only, so it lives only on the container's disk.
   - If the container was stopped since step 6 (the watchdog does that after 20 idle minutes), `/test` refuses with
     "the container has no node_modules…". Run step 6 again, then this step.
   - It doesn't install by itself: an install inside `/test` would mix the two measurements.

   ```
   ! spikes/agent-workspace/call.sh POST /test
   ```

8. **Prompt.** In the record, look at `detail.status` and `detail.inContainerDiff`.

   ```
   ! spikes/agent-workspace/call.sh POST /prompt
   ```

9. **Push (spike 5).**
   - In the record:
     - `detail.landed` should be `true`;
     - `detail.search` should have every `controlSeen` `true` and every `found` `false`.
   - The branch is `factory/spike-5` on `actor-systems/actord`.

   ```
   ! spikes/agent-workspace/call.sh POST /push
   ```

Steps 10 to 13 are spike 4, below. Run them next, then come back for steps 14 and 15.

14. **Run this last: the install without local-only paths.**
    - It relaunches the container with nothing ignored and runs `npm ci` again, so `node_modules` syncs into the
      object. This is the comparison, and maybe computer#179. It may take much longer than step 6.
    - There's no switching back: after it, the workspace holds `node_modules`.

    ```
    ! spikes/agent-workspace/call.sh POST '/install?ignore=off'
    ```

15. **Stop the container.** The watchdog would stop it after 20 minutes without a job.

    ```
    ! spikes/agent-workspace/call.sh POST /stop
    ```

Then tell the controller. Reading the results is not a privileged command:

```
spikes/agent-workspace/call.sh GET /report | jq
```

or, without the helper:

```
curl -sS -H "Authorization: Bearer $(cat spikes/agent-workspace/.spike-token)" "$(grep -o 'https://[a-z0-9.-]*workers\.dev' spikes/agent-workspace/.deploy.log | head -1)/report" | jq
```

## Spike 4: the long run

**The task.** The repository has no `TODO` comments, so `/long` plants its own first. It puts
`// TODO(spike-4): replace this line with a one-sentence comment that says what this file is for.` at the top of 30 files
under `packages/toolkit/src`. It then asks Pi to work through them one file at a time, running
`npm test -w @actord/toolkit` after each. That is more work than 45 minutes holds, so the run ends at a limit unless
the model is quick.

**What's recorded.**
- Every minute the watchdog takes a snapshot: the workspace's `git diff` on the object's side (its SHA-256 and size),
  the changed files, how many TODOs are left, pi's pending operations, the running command, and Computer's sync
  operations.
- Each boot records the Worker version it runs, which tells a deploy from an eviction, and when pi first answered
  after it.

**Before you start.**
- Steps 5 to 9 have run.
- If the container was stopped since the install (after 20 idle minutes, or by step 15), `/long` refuses and says so:
  run step 6 again first.
- Run `/long` once: its $5 stop counts from its own start, so a second run could spend another $5.

10. **Start the long run.** It answers at once with the job's record. `options.seeded` lists the files, and
    `options.deadline` is when the 45 minutes end.

    ```
    ! spikes/agent-workspace/call.sh POST /long
    ```

11. **About 10 minutes in, redeploy during a running command.**
    - Check `/status` until `exec` isn't `null`, which means a command, usually the tests, is running.
    - Then redeploy at once. The image is unchanged, so wrangler should only rebuild from cache.
    - Note the time.

    ```
    ! spikes/agent-workspace/call.sh GET /status
    ! npx wrangler deploy -c spikes/agent-workspace/wrangler.jsonc 2>&1 | tee -a spikes/agent-workspace/.deploy.log
    ```

12. **About 20 minutes in, evict the object.** `during=exec` waits up to 5 minutes for a command to be running, then
    calls `ctx.abort()`. The answer is `{"evicted":true,…}`.

    ```
    ! spikes/agent-workspace/call.sh POST '/evict?during=exec'
    ```

13. **Let it finish.**
    - The job ends when pi settles, or at 45 minutes, $5 of model spend or 200 model responses. The watchdog notices
      within a minute.
    - `/status` shows the job until it ends, with `minutesLeft`; its `kind` is `long`.
    - When `job` is `null`, the job's record in `/report` has `status` (`done` or `stopped`), `detail.stoppedBy` and
      `detail.todosLeft`.

    ```
    ! spikes/agent-workspace/call.sh GET /status
    ```

Then continue with step 14.

## Cost

Expected cost is about $1 to $3, and at most about $6 with every cap reached. The phase-one spike budget has about $20
left. These are list prices; Workers Paid's monthly allowances may cover all of the container time.

**Container time.** `standard-2` costs:
- memory: 6 GiB × $0.0000025 per GiB-second, $0.054 an hour;
- disk: 12 GB × $0.00000007 per GB-second, $0.003 an hour;
- CPU: $0.00002 per vCPU-second while busy, at most $0.072 an hour.

That is at most $0.13 an hour, billed while the container runs.

The container runs:
- for steps 6 to 9, about 30 minutes;
- for spike 4, 45 minutes;
- for step 14, perhaps 30 more;
- after the last job, up to 20 minutes before the watchdog stops it. Step 15 avoids that.

About two and a half hours in all is about $0.35 at most. Workers Paid includes 25 GiB-hours of memory, 375 vCPU-minutes
and 200 GB-hours of disk a month, which is about four hours of `standard-2`.

**Workers AI.** `/prompt` needs about 5 to 8 model calls:
- of perhaps 8,000 input tokens each, mostly tool definitions and the file;
- with 1,000 to 3,000 output tokens each, at the default reasoning.

That is about $0.03. The 15-response cap bounds it near $0.15.

Spike 4 is the larger part. In 45 minutes, perhaps 100 to 150 model calls:
- each call's input grows with the transcript, to tens of thousands of tokens;
- uncached, 150 calls averaging 50,000 input tokens is 7.5 million tokens, about $2.25;
- output adds about $0.40;
- whatever Workers AI's prefix cache serves costs $0.006 per million instead of $0.30.

The watchdog stops the run once its spend reaches $5, counted from pi's token usage at the list prices above, so it can't cost much more than $5. The $6 ceiling assumes one `/long` and a few prompts. No prompt or `/long` starts once the total reaches $8.

**The rest.** The Worker, its Durable Object and the egress requests are a rounding error on Workers Paid. Durable
Object storage holds a few hundred MB at most after step 10.

## Teardown

Run these in this order, from the repository root. Leave `spike-email-approval` (spike 6) alone: every command here
names this spike's config or this spike's application.

1. **Delete the Worker and its Durable Object data:**

   ```
   ! npx wrangler delete -c spikes/agent-workspace/wrangler.jsonc --force
   ```

2. **Find the container application.** This is read-only; look for the one named after `spike-agent-workspace` and
   `bench`:

   ```
   npx wrangler containers list
   ```

3. **Delete the container application.** Deleting the Worker doesn't delete its container application:

   ```
   ! npx wrangler containers delete '<APPLICATION_ID>'
   ```

4. **Find the image.** This is read-only; look for the `spike-agent-workspace` image and its tag:

   ```
   npx wrangler containers images list
   ```

5. **Delete the image:**

   ```
   ! npx wrangler containers images delete '<IMAGE>:<TAG>'
   ```

6. **Delete the branch:**

   ```
   ! git push origin --delete factory/spike-5
   ```

7. **Delete the GitHub App**, which removes its installation too. On
   https://github.com/organizations/actor-systems/settings/apps, open the App, then **Advanced**, then
   **Delete GitHub App**.

8. **Delete the private key and the local files:**

   ```
   ! rm ~/Downloads/actord-spike-5.2026-10-28.private-key.pem spikes/agent-workspace/.spike-token spikes/agent-workspace/.deploy.log
   ```

## Checked locally before handing over

- `npx wrangler types` and `tsc --noEmit` pass with this spike's config.
- **The bundle.** esbuild with wrangler's settings, approximately, makes 4.7 MB, 861 KB gzipped, well under the Worker
  size limit. Every import resolves.
- **Under `wrangler dev`.** This ran with a scratch config: no AI binding (a service binding stood in, never called),
  no containers, and no remote session. It showed:
  - requests without the token, or with a wrong one, got `401`;
  - the object booted, with Lifecycle started, pi open and the workspace schema created, and `/status` and `/report`
    answered;
  - `/clone` cloned the real repository through Computer's git client in 1.8 seconds, putting about 12.7 MB in the
    object's SQLite;
  - `/install`, `/test` and `/long` failed cleanly ("DO is not container-enabled") and `/push` failed cleanly ("set
    GITHUB_APP_ID…"). Each was recorded as `failed`, with no container started;
  - `/evict` reset the object: the next request ran in a second boot, and the eviction's event and snapshot, written
    before `ctx.abort()`, were there.
- **The object-side git calls `/push` and `/prompt` make.** On that clone, these all worked:
  - `branch` with checkout, `status`, `diff` limited to a path, `add`, `commit` and `log`;
  - `.git/config` held no credentials;
  - Computer's `fs.grep` and `fs.find`.
- **The JWT.** It was signed with a PKCS#1 key and with a PKCS#8 key, each with real and with escaped newlines, and
  verified against the public key. The PKCS#1-to-PKCS#8 wrap matches OpenSSL's conversion byte for byte.
- **The image builds.** `docker build --platform linux/amd64` passed: Debian 13, Node 24.22.1, git 2.47.3, 184 MB. It
  was neither run nor pushed.
- **Every `call.sh` line above ran under `zsh -c` exactly as written**, against `wrangler dev` through `SPIKE_URL`. Each
  reached the Worker. The old unquoted `?` forms fail with "no matches found". Every `!` line passes `zsh -n`.
- **The watchdog's error path.** A planted long job whose closing step throws:
  - each tick recorded a `watchdog.error` event and came back a minute later while the job was open;
  - once nothing was live, the watchdog completed and its job was gone.

**Not checked here, because it needs the owner:**
- the container itself;
- the egress gateway and the CA trust;
- Workers AI;
- the GitHub token and push;
- `wrangler deploy`'s handling of the `containers` block;
- the long run, the deploy during it, and the watchdog's minute ticks;
- the seeded TODO comments against the tests: `test/` only imports these files, so a leading comment shouldn't matter.
- `/test`'s and `/long`'s refusal when the container has lost `node_modules` (it needs a container);
- the watchdog's `onJobError` backstop, which runs only if the tick's own error handling throws.

## Results

Not yet run. The results will go in `docs/evidence/spike-2-computer.md`, `docs/evidence/spike-4-long-run.md` and
`docs/evidence/spike-5-push.md`.
