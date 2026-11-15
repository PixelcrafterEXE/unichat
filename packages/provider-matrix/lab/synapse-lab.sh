#!/usr/bin/env bash
# Throwaway Synapse on 127.0.0.1 only (sqlite, no federation, no TLS). Usage: synapse-lab.sh setup|start|stop|status|users|restart
# LAB_DIR (default: <tmp>/matrix-lab) holds the venv, config, db, media. PORT defaults to 8008.
set -euo pipefail
LAB_DIR="${LAB_DIR:-${TMPDIR:-/tmp}/unimsg-matrix-lab}"
PORT="${PORT:-8008}"
SERVER_NAME="${SERVER_NAME:-lab.test}"
SECRET="${SECRET:-lab-shared-secret-not-real}"
PY="$LAB_DIR/venv/bin"
cfg="$LAB_DIR/data/homeserver.yaml"
cmd="${1:-status}"

setup() {
  mkdir -p "$LAB_DIR/data/media"
  [ -x "$PY/python" ] || python3 -m venv "$LAB_DIR/venv"
  [ -x "$PY/synctl" ] || "$PY/pip" install --quiet matrix-synapse
  if [ ! -f "$cfg" ]; then
    (cd "$LAB_DIR/data" && "$PY/python" -m synapse.app.homeserver --server-name "$SERVER_NAME" --config-path "$cfg" --generate-config --report-stats=no >/dev/null)
    "$PY/python" - "$cfg" "$LAB_DIR/data" "$PORT" "$SECRET" <<'PYEOF'
import sys, yaml
cfg, data, port, secret = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
c = yaml.safe_load(open(cfg))
c["listeners"] = [{"port": port, "tls": False, "type": "http", "bind_addresses": ["127.0.0.1"],
                   "resources": [{"names": ["client", "media"], "compress": False}]}]
c["database"] = {"name": "sqlite3", "args": {"database": data + "/homeserver.db"}}
c["media_store_path"] = data + "/media"
c["signing_key_path"] = data + "/signing.key"
c["pid_file"] = data + "/homeserver.pid"
c["log_config"] = data + "/log.config"
c["enable_registration"] = False
c["registration_shared_secret"] = secret
c["federation_domain_whitelist"] = []
c["trusted_key_servers"] = []
c["suppress_key_server_warning"] = True
c["report_stats"] = False
c["serve_server_wellknown"] = False
c["rc_message"] = {"per_second": 1000, "burst_count": 10000}
c["rc_login"] = {"address": {"per_second": 1000, "burst_count": 10000}, "account": {"per_second": 1000, "burst_count": 10000}, "failed_attempts": {"per_second": 1000, "burst_count": 10000}}
c["rc_joins"] = {"local": {"per_second": 1000, "burst_count": 10000}, "remote": {"per_second": 1, "burst_count": 10}}
c["rc_invites"] = {"per_room": {"per_second": 1000, "burst_count": 10000}, "per_user": {"per_second": 1000, "burst_count": 10000}, "per_issuer": {"per_second": 1000, "burst_count": 10000}}
c["rc_registration"] = {"per_second": 1000, "burst_count": 10000}
c["rc_admin_redaction"] = {"per_second": 1000, "burst_count": 10000}
c["allow_public_rooms_over_federation"] = False
open(cfg, "w").write(yaml.safe_dump(c))
PYEOF
    # log to file only (quiet)
    sed -i 's/level: INFO/level: WARNING/; s/^root:.*/root:/' "$LAB_DIR/data/log.config" 2>/dev/null || true
  fi
}

start() {
  setup
  status >/dev/null 2>&1 && { echo "already running"; return; }
  (cd "$LAB_DIR/data" && "$PY/python" -m synapse.app.homeserver -c "$cfg" --daemonize >/dev/null 2>&1) || (cd "$LAB_DIR/data" && nohup "$PY/python" -m synapse.app.homeserver -c "$cfg" >"$LAB_DIR/synapse.out" 2>&1 &)
  for _ in $(seq 1 120); do curl -fs "http://127.0.0.1:$PORT/_matrix/client/versions" >/dev/null 2>&1 && { echo "synapse up on 127.0.0.1:$PORT"; return; }; sleep 1; done
  echo "synapse failed to start" >&2; exit 1
}

stop() {
  local pid; pid="$(cat "$LAB_DIR/data/homeserver.pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && sleep 1 || break; done
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  rm -f "$LAB_DIR/data/homeserver.pid"
  echo stopped
}

status() { curl -fs "http://127.0.0.1:$PORT/_matrix/client/versions" >/dev/null && echo running || { echo stopped; return 1; }; }

reset() { stop >/dev/null; rm -f "$LAB_DIR"/data/homeserver.db* ; rm -rf "$LAB_DIR/data/media"; mkdir -p "$LAB_DIR/data/media"; echo "database + media wiped"; }

users() {
  for u in alice bob carol; do
    "$PY/register_new_matrix_user" -c "$cfg" -u "$u" -p "$u-lab-pass-1" --no-admin "http://127.0.0.1:$PORT" 2>&1 | grep -v -i "success" || true
  done
}

case "$cmd" in
  setup) setup;; start) start;; stop) stop;; status) status;; users) users;; reset) reset;; restart) stop; start;;
  *) echo "usage: $0 setup|start|stop|restart|status|users|reset" >&2; exit 2;;
esac
