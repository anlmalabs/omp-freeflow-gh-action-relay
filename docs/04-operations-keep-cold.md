# 04 — Operations: keep-cold

`keep-cold.mjs` was the pool's diagnostic layer: it probed every relay with a
real streaming inference request per model in `PROBE_MODELS` (chat +
responses wire paths, official-client fingerprint headers), flagged
throttled relays per model, and applied a quota guard to pool-wide 429s.
The systemd timer (`warp-keep-cold.timer`) still fires it every 5 minutes,
but against a direct-egress pool **none of it works** — read the warning
before trusting its output.

> [!IMPORTANT]
> **keep-cold is not yet migrated to direct egress.** It still rotates
> `warp-relay-warp-N` containers — containers the direct-egress
> `docker-compose.yml` no longer creates — so every rotation attempt fails,
> and its SOCKS readiness/egress helpers (`socks5h://127.0.0.1:10800+N`) have
> no listener to talk to. The relay probes themselves are plain `fetch` calls
> and do still work once `RELAY_HOST` points at a reachable relay, but the
> default `10.244.0.100` is the static bridge address the migration removed.
> Treat per-relay liveness as the relay health check's job
> (`curl -s http://127.0.0.1:310N/`), noting the mesh mode's host publish
> (`3101-<3100+N>` → container `3001-<3000+N>`) is the only way to reach it
> from outside the container, and it does not exist on a GitHub Actions runner
> or in a tunnels-only deploy. See "Migration status" for the exact breakdown.

## What the prober does

- Per-model-per-relay: it probes each relay with a real streaming request
  for **each** model in `PROBE_MODELS`, because throttling is per model —
  one relay can answer 200 for one model and 429 for another.
- `GLOBAL_QUOTA_GUARD` (default `max(8, COUNT - 1)`, i.e. 9 at COUNT=10,
  capped at `COUNT`): a model 429ing on that many relays is flagged as
  upstream quota rather than per-relay throttling.
- Speed ranking is logged (`speed <model>: #N Nms …`) but rotation on speed
  is disabled (`SLOW_THRESHOLD_MS=0`): single-sample rank proved to be
  upstream noise. Re-enable only on median-over-N evidence.
- **Upstream `server_error` Detection:** scans the first 2 SSE chunks on
  HTTP 200 responses to catch upstream provider crashes ("The model failed
  to generate a response"), separating an upstream incident from throttling.
- Concurrency: `runPool` bounds parallel work by `ROTATE_CONCURRENCY`.
- Rotation (legacy, currently a no-op against direct egress):
  **tier 1** restarts the relay's WARP client container, **tier 2** wipes
  `/etc/wireguard/wg0.conf` and restarts to force a new account registration.
  The `server_error` path never uses tier 2 — it holds instead.

```bash
node keep-cold.mjs --once            # single pass (what the timer runs)
INTERVAL_S=600 node keep-cold.mjs --loop   # pass every 10 min, foreground
```

## Tunables

| Env | Default | Meaning |
| --- | --- | --- |
| `RELAY_HOST` | `10.244.0.100` | Legacy (unmigrated) default — the old static bridge address, which the migration removed, so out of the box no probe connects. Set to `127.0.0.1` for a mesh-mode deploy |
| `BASE_PORT` | `3000` | Relay N probed at `BASE_PORT+N` |
| `COUNT` | `10` | Relays probed |
| `SOCKS_HOST` | `127.0.0.1` | Host dialed for the legacy SOCKS readiness/egress probes |
| `PROBE_TARGET` | `https://api.kilo.ai` | Upstream the probes go through (Zen's free tier refuses non-OpenCode clients since 2026-10-14) |
| `PROBE_CHAT_PATH` / `PROBE_RESPONSES_PATH` | `/api/gateway/chat/completions` / `/api/gateway/responses` | Wire paths under `PROBE_TARGET` |
| `PROBE_MODELS` | `nvidia/nemotron-3.5-lightning:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free` | One probe each per relay (`PROBE_MODEL` = legacy single override) |
| `RESPONSES_MODELS` | `dots-studio/dots-3-note-preview:free` | Probed via `PROBE_RESPONSES_PATH`; rest via `PROBE_CHAT_PATH` |
| `GLOBAL_QUOTA_GUARD` | `max(8, COUNT - 1)` (= 9 at `COUNT=10`) | 429-on-this-many-relays = upstream quota, skip rotation (capped at `COUNT`) |
| `SPEED_MODEL` / `SLOW_THRESHOLD_MS` / `SLOW_MAX_ROTATIONS` | `nvidia/nemotron-3.5-lightning:free` / `0` / `2` | Speed rotation, disabled by default |
| `MAX_ROTATIONS` | `4` | Restarts per throttled relay per pass |
| `ROTATE_CONCURRENCY` | `3` | Parallel restarts |
| `CONTAINER_PREFIX` | `warp-relay-warp-` | Legacy `docker restart ${PREFIX}N` target — no such containers in direct-egress mode |
| `READY_TIMEOUT_MS` / `PROBE_TIMEOUT_MS` | `180000` / `30000` | Legacy WARP-ready wait / per-probe timeout |
| `INTERVAL_S` | `300` | `--loop` seconds between passes |
| `KEEP_COLD_LOG` (+ `_MAX_BYTES` / `_KEEP_BYTES`) | stdout only / `2 MiB` / `200 KiB` | Optional file log with self-rotation |

## Migration status

What still works (verified against `keep-cold.mjs`):

- **The relay probes themselves.** `probe()` is a plain `fetch` to
  `http://${RELAY_HOST}:${BASE_PORT + index}` — no SOCKS, no WARP. Point
  `RELAY_HOST` at a reachable relay (`127.0.0.1` in mesh mode, where `310N`
  is host-published) and per-model probing, the quota guard, and the
  `server_error` classification all produce real results.
- **The no-touch rule.** keep-cold never restarts `tunnel-N` or `relay`, so
  public URLs and in-flight connections survive a pass.

What is dead until the prober is migrated:

- **Rotation, entirely.** `docker restart warp-relay-warp-N` has no target
  container, so every rotation attempt fails. Worse, with direct egress there
  is nothing to rotate *to*: every relay shares the host IP, so a per-IP 429
  throttles the entire pool and no restart can change the address. See
  [05](05-troubleshooting-faq.md).
- **The SOCKS helpers.** `warpReady()` and the egress-IP reader dial
  `socks5h://127.0.0.1:10800+N`; no SOCKS listener exists now, so both fail
  instead of waiting for a WARP handshake. A pass therefore logs a readiness
  failure and an unknown egress IP even when the probe above succeeded.
- **The default `RELAY_HOST`.** This legacy (unmigrated) default is still
  `10.244.0.100` — the static bridge address the migration removed, which no
  longer exists in the current topology — so out of the box probes cannot
  reach any relay. Set it explicitly.

Since the relay now dials the upstream itself, a direct-egress prober would
have a simpler job than this one: probe the relay directly, report throttling,
and never try to buy a new IP. Until then, set `RELAY_HOST` for the probe
signal and ignore the rotation and readiness lines — watch pool-wide 429s by
hand or with `logwatch.sh`.

The prober is also the reason `systemd/warp-keep-cold.timer` is still named
`warp-*`: renaming the units is coupled to migrating the script, and the
service names appear in `logwatch.sh`, `setup.sh`, and these docs.

## Logs

Stdout always (journald: `journalctl -u warp-keep-cold.service`);
`KEEP_COLD_LOG=/path/keep-cold.log` additionally appends to a self-
rotating file. Each pass logs per-relay `200`/`429` per model, rotation
attempts, quota-guard skips, and the speed line.
