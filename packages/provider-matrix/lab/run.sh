#!/usr/bin/env bash
# Starts the lab Synapse (127.0.0.1 only), runs the real-homeserver suite, stops Synapse. See synapse-lab.sh for LAB_DIR/PORT.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export LAB_DIR="${LAB_DIR:-${TMPDIR:-/tmp}/unimsg-matrix-lab}"
"$here/synapse-lab.sh" setup || exit 1
"$here/synapse-lab.sh" reset >/dev/null   # fresh database every run: the suite assumes empty accounts
"$here/synapse-lab.sh" start || exit 1
trap '"$here/synapse-lab.sh" stop' EXIT
"$here/synapse-lab.sh" users >/dev/null 2>&1
cd "$here/.." || exit 1
LAB_HS="http://127.0.0.1:${PORT:-8008}" LAB_DIR="$LAB_DIR" PORT="${PORT:-8008}" node --experimental-strip-types --import ./test-loader.mjs --test --test-force-exit --test-concurrency=1 --test-timeout=300000 "${@:-lab/synapse.e2e.ts}"
