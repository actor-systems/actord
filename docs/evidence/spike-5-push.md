# Spike 5: a push from the Durable Object with a GitHub App installation token

**Run:** 2026-10-27, 19:26–19:27 UTC.
- **Where:** the `spike-agent-workspace` Worker (Workers Paid). The Worker ran version `d7db0c70` (boot 3), and the
  container was runtime `2521bbf8`.
- **Software:** `@cloudflare/computer` 0.8.0, image digest `sha256:ed7f6f6d…`, wrangler 4.152.0.
- **The App:** `actord-spike-5` (App ID 5500266) under `actor-systems`. It has Contents read and write and Metadata
  read, and is installed on `actor-systems/actord` only (installation 175935201).

**Setup:**
- **The code.** `spikes/agent-workspace/src/index.ts`, `POST /push`, as `spikes/agent-workspace/README.md` describes.
- **The token.** The object signs an App JWT (RS256, from the PKCS#1 key wrapped to PKCS#8), mints an installation
  token, and passes it to Computer's git client as an `Authorization` header. It never goes into `.git/config`, and
  never into the container.
- **The push.** It goes to a pinned URL, `https://github.com/actor-systems/actord`, with `corsProxy: ""`. The order is
  Bearer first, then Basic `x-access-token:<token>` only after an auth failure. At the time of the run, that was the
  order `gitPushEffect` used (`packages/toolkit/src/agents/git.ts`, before 9982ab1, which made it Basic only).
- **The search.** The spike then searches the container for the token, and revokes the token.

## Results

| Question | Observed | Result |
| --- | --- | --- |
| What did the token grant? | `contents: write`, `metadata: read`, `repositorySelection: selected`, `["actor-systems/actord"]`. It expired an hour after minting (`20:27:05Z`). | as configured |
| Does GitHub take Bearer on the git endpoint? | No. The push failed with `git push failed: HTTP Error: 401 Unauthorized`. This is Computer's `EPUSHFAIL` wrapping isomorphic-git's `HttpError`, and `gitPushEffect`'s auth-failure check, as the code stood at the time of the run (before 9982ab1 removed it), matched it. | **no** |
| Does Basic `x-access-token` work? | Yes. The second attempt landed `factory/spike-5` at `ecc2701`. A separate read of the remote head gave the same commit. | **pass** |
| Is the token in the container? | No, in any of four places. A control canary planted in each place was found every time, so the searches worked. | **pass** |
| Did anything persist the token in the object? | No. `.git/config` after the push holds `remote.origin.url` and `branch.main`, with no credentials and no `http.*` keys. The object's vfs search found nothing. | **pass** |
| Was the token revoked? | Yes. `DELETE /installation/token` answered `204`. | pass |
| How long did it take? | 15.8 s for the whole job: the JWT, the token, two push attempts, the four searches and the revoke. The three container searches took 0.75 s, 2.4 s and 0.1 s. | — |

The four places searched for the token:
- **the exec environment** (`env`). Its names were only `HOME`, `OLDPWD`, `PATH`, `PWD` and the canary passed to that
  exec;
- **every file under `/workspace`** (`grep -rl -F`);
- **every process's `/proc/<pid>/environ`**, four processes;
- **the object's vfs.**

Ruling: `gitPushEffect` and `gitClone` authenticate with Basic `x-access-token:<token>` only, not Bearer first, because GitHub's git endpoint answers Bearer with 401 (this run) and Basic is what it takes — cost if wrong: a git host that accepts only Bearer needs an option to choose the scheme.

Ruling: review finding M5 is confirmed: `gitClone`'s Bearer-only header fails against GitHub, so a clone of a private repository fails until it sends Basic. The Task 9 follow-up fixes it with the ruling above — cost if wrong: none; a public clone needs no credentials either way.

## What this changes in the toolkit (Task 9 follow-up)

- **The auth scheme.** `gitPushEffect` sends Basic first; the Bearer attempt goes. `gitClone` sends Basic. The tests
  that pin the Bearer-then-Basic order change with it.
- **The scrubbing.** The scrubber already covers the token inside the Basic value's base64 form. The 401 text above
  carries no token, so a test that a 401 surfaces as itself, without the header, pins the scrubbing.

## Not checked here

- **Refnames.** Whether Computer's git client validates a refname before pushing. `gitPushEffect`'s `allow`
  (`factory/*`) runs first, so the branch name never reaches git unchecked.
- **A rejected push.** What a non-fast-forward or a protected-branch refusal returns.
- **The corsProxy residual.** It is issue #79. This run's `.git/config` had no `http.corsProxy`, so the re-check passed
  as expected.
