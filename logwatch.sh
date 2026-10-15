#!/bin/sh
# logwatch.sh — central error-log watcher for the warp-relay pool.
#
# Scrapes `docker logs --since` for the relay app + warp-1..N and
# `journalctl --since` for the keep-cold controller, appends matching
# error lines to logs/errors.log, and emits one summary line per relay
# per day. Read-only on the pool: never restarts or rebuilds anything.
#
# Usage: ./logwatch.sh            (every 2 min via warp-logwatch.timer)
#   POOL_DIR=...      pool checkout (default: directory of this script)
#   LOG_DIR=...       output dir (default: $POOL_DIR/logs)
#   COUNT=...         relay count (default 10)
#   CONTAINER_PREFIX=...  (default warp-relay-warp-)
#   APP_CONTAINER=...     (default warp-relay-app)
#   JOURNAL_UNIT=...      (default warp-keep-cold.service)
#   MAX_BYTES=...     rotate errors.log at this size (default 10485760)
#   KEEP_ROTATED=...  rotated files to keep (default 5)
#   FIRST_SINCE_DOCKER=...  (default 24h; used only with no cursor yet)
#   FIRST_SINCE_JOURNAL=... (default "24 hours ago"; same)
#
# State (all inside $LOG_DIR, survives restarts):
#   .cursor  epoch seconds of the last scrape start (next --since)
#   .last    last emitted raw line per source (skips --since overlap)
#   .events  "relay class n" tallies for the current UTC day
#   .day     UTC day (YYYY-MM-DD) the .events tallies belong to
set -eu

POOL_DIR="${POOL_DIR:-$(cd "$(dirname "$0")" && pwd)}"
LOG_DIR="${LOG_DIR:-$POOL_DIR/logs}"
COUNT="${COUNT:-10}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-warp-relay-warp-}"
APP_CONTAINER="${APP_CONTAINER:-warp-relay-app}"
JOURNAL_UNIT="${JOURNAL_UNIT:-warp-keep-cold.service}"
MAX_BYTES="${MAX_BYTES:-10485760}"
KEEP_ROTATED="${KEEP_ROTATED:-5}"
FIRST_SINCE_DOCKER="${FIRST_SINCE_DOCKER:-24h}"
FIRST_SINCE_JOURNAL="${FIRST_SINCE_JOURNAL:-24 hours ago}"

ERRLOG="$LOG_DIR/errors.log"
CURSOR="$LOG_DIR/.cursor"
LAST="$LOG_DIR/.last"
EVENTS="$LOG_DIR/.events"
DAYFILE="$LOG_DIR/.day"

# Case-insensitive (callers pass -i). Bare 429/500/502/403 are
# digit-guarded so PIDs and ports never match; everything else is a
# plain substring. g(a|i)ve covers both GIVE UP and GAVE UP.
MATCH_RE='error|fail|refus|timeout|g(a|i)ve up|troubled|server_error|still failing|unexpected http|proxy error|fetch failed|econnrefused|epipe|(^|[^0-9])(429|500|502|403)([^0-9]|$)'

mkdir -p "$LOG_DIR"
TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT INT TERM

NOW="$(date +%s)"
TODAY="$(date -u +%F)"
STAMP="$(date -u +%FT%TZ)"

if [ -f "$CURSOR" ]; then
  SINCE_EPOCH="$(cat "$CURSOR")"
  case "$SINCE_EPOCH" in ''|*[!0-9]*) SINCE_EPOCH="";; esac
else
  SINCE_EPOCH=""
fi

rotate() {
  # Rotate errors.log at MAX_BYTES, keeping KEEP_ROTATED files:
  # errors.log.1 .. errors.log.KEEP_ROTATED (60 MiB cap at defaults).
  [ -f "$ERRLOG" ] || return 0
  rot_size="$(wc -c < "$ERRLOG")"
  [ "$rot_size" -ge "$MAX_BYTES" ] || return 0
  rot_i="$KEEP_ROTATED"
  while [ "$rot_i" -gt 1 ]; do
    rot_prev=$((rot_i - 1))
    [ -f "$ERRLOG.$rot_prev" ] && mv -f "$ERRLOG.$rot_prev" "$ERRLOG.$rot_i"
    rot_i="$rot_prev"
  done
  mv -f "$ERRLOG" "$ERRLOG.1"
}

classify() {
  # Echo the error class for one matched line ($1).
  line="$1"
  if printf '%s' "$line" | grep -qi -E '(^|[^0-9])429([^0-9]|$)'; then echo http_429
  elif printf '%s' "$line" | grep -qi -E '(^|[^0-9])(500|502)([^0-9]|$)|unexpected http'; then echo http_5xx
  elif printf '%s' "$line" | grep -qi -E '(^|[^0-9])403([^0-9]|$)'; then echo http_403
  elif printf '%s' "$line" | grep -qi -E 'refus|timeout|econnrefused|epipe|fetch failed|proxy error'; then echo conn
  elif printf '%s' "$line" | grep -qi -E 'server_error'; then echo upstream
  elif printf '%s' "$line" | grep -qi -E 'g(a|i)ve up|troubled|still failing'; then echo controller
  else echo other
  fi
}

attribute() {
  # Echo the relay label (1..N, app, pool) for source $1 + line $2.
  src="$1"
  line="$2"
  case "$src" in
    "$CONTAINER_PREFIX"*)
      echo "${src#$CONTAINER_PREFIX}"
      return 0
      ;;
    "$APP_CONTAINER")
      n="$(printf '%s' "$line" | sed -n 's/.*[Rr]elay[^0-9]*#\?\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      [ -n "$n" ] && echo "$n" || echo "app"
      return 0
      ;;
  esac
  n="$(printf '%s' "$line" | sed -n 's/.*#\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$n" ] && echo "$n" || echo "pool"
}

get_last() {
  # Echo the stored last raw line for source $1 (empty when unknown).
  [ -f "$LAST" ] || return 0
  awk -F'	' -v s="$1" '$1 == s { p = index($0, "	"); print substr($0, p + 1); exit }' "$LAST"
  return 0
}

set_last() {
  # Record raw line $2 as the last emitted line for source $1.
  tmp="$TMPDIR_WORK/last.new"
  if [ -f "$LAST" ]; then
    awk -F'	' -v s="$1" '$1 != s' "$LAST" > "$tmp"
  else
    : > "$tmp"
  fi
  printf '%s	%s\n' "$1" "$2" >> "$tmp"
  mv -f "$tmp" "$LAST"
}

emit_group() {
  # Append one (possibly collapsed) group: source $1, raw line $2,
  # repeat count $3. Records the daily tally with its multiplicity.
  # NOTE: locals are eg_-prefixed — sh functions share global scope,
  # and callers (process_source) rely on their own vars surviving.
  eg_src="$1"; eg_line="$2"; eg_count="$3"
  if [ "$eg_count" -gt 1 ]; then
    printf '[%s] %s (x%d)\n' "$eg_src" "$eg_line" "$eg_count" >> "$ERRLOG"
  else
    printf '[%s] %s\n' "$eg_src" "$eg_line" >> "$ERRLOG"
  fi
  eg_class="$(classify "$eg_line")"
  eg_relay="$(attribute "$eg_src" "$eg_line")"
  printf '%s %s %d\n' "$eg_relay" "$eg_class" "$eg_count" >> "$EVENTS"
  set_last "$eg_src" "$eg_line"
}

process_source() {
  # Dedupe + emit the matched raw lines (file $2) for source $1:
  # skip leading lines identical to the stored last line (--since
  # overlap refetch), then collapse consecutive repeats with (xN).
  # (grep output never holds empty lines: no pattern matches one.)
  # NOTE: ps_-prefixed vars — emit_group must not clobber these.
  ps_src="$1"; ps_file="$2"
  [ -s "$ps_file" ] || return 0
  ps_stored="$(get_last "$ps_src")"
  ps_skipping="yes"
  ps_cur=""; ps_count=0
  while IFS= read -r ps_line || [ -n "$ps_line" ]; do
    [ -n "$ps_line" ] || continue
    if [ "$ps_skipping" = "yes" ]; then
      if [ -n "$ps_stored" ] && [ "$ps_line" = "$ps_stored" ]; then
        continue
      fi
      ps_skipping="no"
    fi
    if [ "$ps_count" -eq 0 ]; then
      ps_cur="$ps_line"; ps_count=1
    elif [ "$ps_line" = "$ps_cur" ]; then
      ps_count=$((ps_count + 1))
    else
      emit_group "$ps_src" "$ps_cur" "$ps_count"
      ps_cur="$ps_line"; ps_count=1
    fi
  done < "$ps_file"
  if [ "$ps_count" -gt 0 ]; then
    emit_group "$ps_src" "$ps_cur" "$ps_count"
  fi
}

summarize_day() {
  # Append one summary line per relay for day $1, aggregated from
  # .events, then clear the tallies. Relays 1..N always get a line
  # (zeros prove the watcher ran); app/pool only when nonzero.
  # NOTE: sum_-prefixed vars — the main scrape loop below uses $i.
  sum_day="$1"
  sum_i=1
  while [ "$sum_i" -le "$COUNT" ]; do
    sum_tally="$TMPDIR_WORK/tally.$sum_i"
    : > "$sum_tally"
    [ -f "$EVENTS" ] && grep "^$sum_i " "$EVENTS" > "$sum_tally" || true
    sum_429=0; sum_5xx=0; sum_403=0; sum_conn=0; sum_up=0; sum_ctrl=0; sum_other=0
    while read -r sum_r sum_cls sum_n || [ -n "$sum_r" ]; do
      [ -z "${sum_r:-}" ] && continue
      case "${sum_n:-}" in ''|*[!0-9]*) continue;; esac
      case "$sum_cls" in
        http_429) sum_429=$((sum_429 + sum_n));;
        http_5xx) sum_5xx=$((sum_5xx + sum_n));;
        http_403) sum_403=$((sum_403 + sum_n));;
        conn) sum_conn=$((sum_conn + sum_n));;
        upstream) sum_up=$((sum_up + sum_n));;
        controller) sum_ctrl=$((sum_ctrl + sum_n));;
        *) sum_other=$((sum_other + sum_n));;
      esac
    done < "$sum_tally"
    sum_total=$((sum_429 + sum_5xx + sum_403 + sum_conn + sum_up + sum_ctrl + sum_other))
    printf '%s [summary] day=%s relay=%d 429=%d 5xx=%d 403=%d conn=%d upstream=%d controller=%d other=%d total=%d\n' \
      "$STAMP" "$sum_day" "$sum_i" "$sum_429" "$sum_5xx" "$sum_403" "$sum_conn" "$sum_up" "$sum_ctrl" "$sum_other" "$sum_total" >> "$ERRLOG"
    sum_i=$((sum_i + 1))
  done
  for sum_label in app pool; do
    sum_tally="$TMPDIR_WORK/tally.$sum_label"
    : > "$sum_tally"
    [ -f "$EVENTS" ] && grep "^$sum_label " "$EVENTS" > "$sum_tally" || true
    [ -s "$sum_tally" ] || continue
    sum_429=0; sum_5xx=0; sum_403=0; sum_conn=0; sum_up=0; sum_ctrl=0; sum_other=0
    while read -r sum_r sum_cls sum_n || [ -n "$sum_r" ]; do
      [ -z "${sum_r:-}" ] && continue
      case "${sum_n:-}" in ''|*[!0-9]*) continue;; esac
      case "$sum_cls" in
        http_429) sum_429=$((sum_429 + sum_n));;
        http_5xx) sum_5xx=$((sum_5xx + sum_n));;
        http_403) sum_403=$((sum_403 + sum_n));;
        conn) sum_conn=$((sum_conn + sum_n));;
        upstream) sum_up=$((sum_up + sum_n));;
        controller) sum_ctrl=$((sum_ctrl + sum_n));;
        *) sum_other=$((sum_other + sum_n));;
      esac
    done < "$sum_tally"
    sum_total=$((sum_429 + sum_5xx + sum_403 + sum_conn + sum_up + sum_ctrl + sum_other))
    printf '%s [summary] day=%s relay=%s 429=%d 5xx=%d 403=%d conn=%d upstream=%d controller=%d other=%d total=%d\n' \
      "$STAMP" "$sum_day" "$sum_label" "$sum_429" "$sum_5xx" "$sum_403" "$sum_conn" "$sum_up" "$sum_ctrl" "$sum_other" "$sum_total" >> "$ERRLOG"
  done
  : > "$EVENTS"
}

# Day rollover: yesterday's tallies become summary lines first.
if [ -f "$DAYFILE" ]; then
  prev_day="$(cat "$DAYFILE")"
else
  prev_day="$TODAY"
  printf '%s' "$TODAY" > "$DAYFILE"
fi
rotate
: >> "$ERRLOG"
if [ "$prev_day" != "$TODAY" ]; then
  summarize_day "$prev_day"
  printf '%s' "$TODAY" > "$DAYFILE"
fi
[ -f "$EVENTS" ] || : > "$EVENTS"

# Scrape docker sources with timestamps (timestamps ride along as the
# log timestamp, so no clock conversion is needed anywhere).
if [ -n "$SINCE_EPOCH" ]; then
  D_SINCE="$SINCE_EPOCH"
  J_SINCE="@$SINCE_EPOCH"
else
  D_SINCE="$FIRST_SINCE_DOCKER"
  J_SINCE="$FIRST_SINCE_JOURNAL"
fi

scrape_docker() {
  # Matched raw lines for container $1 go to stdout (never fails).
  docker logs --timestamps --since "$D_SINCE" "$1" 2>&1 \
    | grep -a -i -E "$MATCH_RE" || true
}

i=1
while [ "$i" -le "$COUNT" ]; do
  out="$TMPDIR_WORK/docker-$i"
  scrape_docker "$CONTAINER_PREFIX$i" > "$out" || true
  process_source "$CONTAINER_PREFIX$i" "$out"
  i=$((i + 1))
done

out="$TMPDIR_WORK/docker-app"
scrape_docker "$APP_CONTAINER" > "$out" || true
process_source "$APP_CONTAINER" "$out"

out="$TMPDIR_WORK/journal"
  journalctl -u "$JOURNAL_UNIT" --since "$J_SINCE" --no-pager 2>&1 \
    | grep -a -i -E "$MATCH_RE" > "$out" || true
process_source "$JOURNAL_UNIT" "$out"

# Advance the cursor to this run's start: strictly forward, no gaps;
# the <=2s overlap refetch is folded by the .last skip above.
printf '%s' "$NOW" > "$CURSOR"
