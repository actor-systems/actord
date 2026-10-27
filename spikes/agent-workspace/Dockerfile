# The spike's container: computerd (Computer's container daemon), FUSE, git, and Node 24 for npm and the tests.
#
# This follows cloudflare/computer's examples/container image at the version we pin, with five changes:
# - Node 24, as CI runs, from NodeSource, in place of 22;
# - git trusts every directory, because the repository under the FUSE mount at /workspace may not be owned by the
#   user that runs a command, and git refuses such a repository otherwise;
# - Node and npm trust the egress CA. The backend intercepts outbound HTTPS so the Durable Object's gateway can
#   decide each request, and the platform writes that CA to /etc/cloudflare/certs once the intercept is registered.
#   Node reads NODE_EXTRA_CA_CERTS when a process starts; computerd itself starts before the file exists, and only
#   warns;
# - git in the container takes no optional locks, so `git diff` and `git status` don't rewrite .git/index. The object's
#   git client owns the index, and a rewrite would sync back over it;
# - npm's update check, funding messages and audit are off: the gateway refuses the audit's POST anyway.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.8.0 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd's defaults: HTTP and WebSocket on :8080, the FUSE mount at MOUNT_POINT. FUSE_MOUNT=auto uses real FUSE on
# Cloudflare Containers.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
ENV GIT_OPTIONAL_LOCKS=0
ENV npm_config_update_notifier=false
ENV npm_config_fund=false
ENV npm_config_audit=false
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
