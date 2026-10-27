#!/bin/sh
# Calls the deployed spike: call.sh METHOD PATH, for example `call.sh POST /clone`.
# It reads the bearer token from .spike-token and the Worker's URL from .deploy.log, both git-ignored, so neither has to
# be typed. The POSTs stream NDJSON: a {"waiting":seconds} line every 15 seconds, then the job's record.
set -eu
dir=$(dirname "$0")
url=$(grep -o 'https://[a-z0-9.-]*workers\.dev' "$dir/.deploy.log" | head -1)
exec curl -sSN -X "$1" -H "Authorization: Bearer $(cat "$dir/.spike-token")" "$url$2"
