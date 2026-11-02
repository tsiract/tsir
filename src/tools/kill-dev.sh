#!/usr/bin/env bash
#
# Stop the Tsir development server — and nothing else.
#
# Contract:
#   1. Only processes recorded by src/tools/dev.ts are considered.
#   2. A PID is only signalled when (a) it is alive, (b) its recorded start
#      label still matches (guards against PID reuse), and (c) its command line
#      is a Tsir dev server.
#   3. Ports recorded by the dev server are verified free afterwards.
#   4. Unknown owners of a port are reported, never killed.
#   5. Idempotent: running with nothing active exits 0.
#
set -o pipefail

ROOT="${TSIR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUNTIME_DIR="${ROOT}/.tsir"
RECORD_TSV="${RUNTIME_DIR}/dev.pids"
RECORD_JSON="${RUNTIME_DIR}/dev.json"

DRAIN_SECONDS="${TSIR_KILL_DRAIN:-10}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
else
  C_DIM=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_RESET=''
fi

note() { printf '  %s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }

pids=()
labels=()
ports=()

# Is something listening on 127.0.0.1:<port>? (bash /dev/tcp, no dependencies)
is_port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

start_label() {
  ps -o lstart= -p "$1" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'
}

owner_of_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
  fi
}

# ─── Collect records ─────────────────────────────────────────────────────────

if [ -f "$RECORD_TSV" ]; then
  while IFS=$'\t' read -r pid port label; do
    [ -z "${pid:-}" ] && continue
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    pids+=("$pid")
    if [ -n "${port:-}" ]; then ports+=("$port"); fi
    labels+=("${label:-}")
  done <"$RECORD_TSV"
elif [ -f "$RECORD_JSON" ]; then
  # Compatibility fallback for records written by an older dev server.
  while read -r pid; do
    [ -z "$pid" ] && continue
    pids+=("$pid")
    labels+=("")
  done < <(grep -o '"pid"[[:space:]]*:[[:space:]]*[0-9]*' "$RECORD_JSON" | grep -o '[0-9]*$')
  while read -r port; do
    [ -z "$port" ] && continue
    ports+=("$port")
  done < <(grep -o '"ports"[[:space:]]*:[[:space:]]*\[[^]]*\]' "$RECORD_JSON" | grep -Eo '[0-9]+')
fi

if [ "${#pids[@]}" -eq 0 ]; then
  note "${C_DIM}no recorded dev processes${C_RESET}"
  rm -f "$RECORD_TSV" "$RECORD_JSON" 2>/dev/null
  ok "nothing to stop"
  exit 0
fi

# ─── Signal recorded processes ──────────────────────────────────────────────

signalled=()

index=0
for pid in "${pids[@]}"; do
  recorded_label="${labels[$index]:-}"
  index=$((index + 1))
  if ! kill -0 "$pid" 2>/dev/null; then
    note "${C_DIM}already stopped${C_RESET} (pid ${pid})"
    continue
  fi

  live_label="$(start_label "$pid")"
  if [ -n "$recorded_label" ] && [ -n "$live_label" ] && [ "$recorded_label" != "$live_label" ]; then
    warn "pid ${pid} was reused by another process — not touching it"
    continue
  fi

  command_line="$(ps -o command= -p "$pid" 2>/dev/null)"
  case "$command_line" in
    *tools/dev.ts*) ;;
    *)
      warn "pid ${pid} is not a Tsir dev server — not touching it"
      note "${C_DIM}${command_line}${C_RESET}"
      continue
      ;;
  esac

  if kill -TERM "$pid" 2>/dev/null; then
    signalled+=("$pid")
  else
    warn "could not signal pid ${pid} (permission?)"
  fi
done

# ─── Wait for graceful exit, then escalate ──────────────────────────────────

deadline=$((SECONDS + DRAIN_SECONDS))
while [ "${#signalled[@]}" -gt 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
  alive=0
  for pid in "${signalled[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then alive=1; fi
  done
  [ "$alive" -eq 0 ] && break
  sleep 0.2
done

for pid in "${signalled[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    warn "pid ${pid} did not exit in ${DRAIN_SECONDS}s — sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  else
    ok "stopped dev server (pid ${pid})"
  fi
done

# ─── Verify recorded ports are free ─────────────────────────────────────────

exit_code=0
for port in "${ports[@]}"; do
  # Give the OS a moment to release the listener after process exit.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_port_open "$port" || break
    sleep 0.1
  done
  if is_port_open "$port"; then
    owner="$(owner_of_port "$port")"
    err "port ${port} is still in use${owner:+ by ${owner}} — not killed (unknown owner)"
    exit_code=1
  else
    note "${C_DIM}port ${port} released${C_RESET}"
  fi
done

rm -f "$RECORD_TSV" "$RECORD_JSON" 2>/dev/null

if [ "$exit_code" -eq 0 ]; then
  ok "cleanup complete"
else
  warn "cleanup finished with warnings — resolve the port conflict above"
fi
exit "$exit_code"
