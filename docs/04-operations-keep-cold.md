# 04 — Operations: throttle detection

`probe.mjs` is the pool's diagnostic layer. It probes every relay with a
real streaming inference request per model in `PROBE_MODELS` (chat +
responses wire paths, upstream fingerprint headers), classifies throttling
per model, and reports per relay+model. It is **detection only**: no docker
calls, no restarts, and nothing to rotate. The `warp-keep-cold.timer` systemd
timer fires it every 5 minutes; the unit and timer keep those names because
`logwatch.sh` and `logwatch.test.sh` reference them.

> [!IMPORTANT]
> **A pass cannot fix anything.** The pool egresses directly from the host IP
> (see [01](01-overview-how-it-works.md)#why-per-relay-egress-is-gone), so a
> restart returns the same IP. There is nothing to rotate to. The prober
> reports and exits: it never touches a container, a tunnel, or the relay
> app, and it cannot clear a 429. Remedying a per-IP limit means a different
> egress address — redeploy, or a new GitHub Actions run.

## What the prober does

- Per-model-per-relay: one real streaming inference request to each relay
  for **each** model in `PROBE_MODELS`, because throttling is per model —
  one relay can answer 200 for one model and 429 for another. Results are
  reported per relay+model (`#3 dots-studio/dots-3-note-preview:free
  throttled (429)`), not as a pool-level verdict.
- Upstream fingerprint: the chat body carries the official-client headers
  and tool declarations the proxy sends, so a request the upstream would
  reject on shape does not mask the 429 being looked for. `PROBE_TARGET`
  defaults to `https://api.kilo.ai`, the lane that accepts these requests;
  the fingerprint is kept for pools still pointed at opencode.ai.
- `GLOBAL_QUOTA_GUARD` (default `max(8, COUNT - 1)`, i.e. 9 at COUNT=10,
  capped at `COUNT`): a model 429ing on that many relays is reported as
  upstream quota against the shared egress rather than as per-relay
  throttling (`<model> throttled on 9/10 relays — upstream quota on the
  shared egress, not per-relay throttling`). The same line is also tagged
  `[quota-capped]` on each per-relay entry. Without the guard, a pool-wide
  wave would look identical to N independently throttled relays — under one
  shared egress the whole pool throttles at once, so that reading is the
  wrong model of the failure.
  The guard is a **reporting threshold only**: it decides how a 429 wave is
  *described*, never whether the pass counts it. A pool-wide wave is still
  a failure — the pass exits 1 either way, so the summary line and the
  exit code agree.
  Tuning: raise `GLOBAL_QUOTA_GUARD` toward `COUNT` to demand more
  agreement before calling something upstream quota; lower it (down to 1)
  to flag quota sooner, at the cost of calling a handful of genuinely
  throttled relays "quota". The cap at `COUNT` is enforced in code, so a
  larger value cannot change behavior.
- Shared egress: each pass first reads relay #1's health endpoint, which
  answers `Relay #1 OK (direct)` with a Cloudflare trace body carrying
  `ip=`. That address is logged once per pass (`egress <ip> (relay #1
  health check — the one IP the whole pool shares)`) — the number a 429
  actually applies to. It is a plain `fetch` from the probe host against the
  host-published port; the relay container has no curl/wget.
- Latency ranking (`speed <model>: #N Nms …`) is logged for observability
  only. One shared egress means no relay can be faster upstream than
  another, so spread there is upstream variance, not pool health, and
  nothing acts on it.
- Unreachable relays are counted separately from throttled ones. A relay
  that refuses to connect reports `unreachable — <detail>`, and the summary
  line lists its index. An unreachable relay is not evidence of throttling.
- **Upstream `server_error` detection.** An HTTP 200 can still carry an
  upstream failure inside the SSE envelope (`server_error`,
  `response.failed`, "failed to generate"), so the probe reads at most the
  first two SSE chunks (~4 KiB) of every 200 body and cancels the rest. A
  non-200 JSON body carrying the same text is detected the same way. This
  separates an upstream incident from throttling, and it raises the exit
  code — a probe that never read the body would report a dead upstream as
  clean.

```bash
probe.mjs --once                        # single pass (what the timer runs)
INTERVAL_S=600 probe.mjs --loop         # pass every 10 min, foreground
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every probed relay/model pair answered HTTP 200 — the pass fully measured the pool |
| `1` | At least one relay/model pair failed: throttled (429), unreachable, an unexpected status, or a `server_error` inside a 200 stream |
| `2` | The pass could not measure the pool at all — invalid configuration, or a topology it cannot address |

Exit 0 means every probed relay/model pair answered 200 — not merely "no
429 was logged". Exit 1 means at least one pair was throttled or failed.
`GLOBAL_QUOTA_GUARD` changes the *wording* of the report, not the exit code:
a pool-wide wave is described as upstream quota on the shared egress (and
tagged `[quota-capped]` on each per-relay entry), but it still exits 1 — so
the summary line (`clean 0/N`) and the exit code always agree.

Exit 1 covers more than throttling:

- A 429 on any relay/model pair raises it, including a wave that trips
  `GLOBAL_QUOTA_GUARD`. The guard decides how the wave is described, not
  whether it counts.
- An unreachable relay **does** raise exit 1, so a pass over a pool that is
  entirely down reports failure. That is deliberate: it is a pool this pass
  could not actually measure, and reporting it clean would be the silent
  green path. A 429 cannot be detected on a relay that never answers.
- `server_error` results also raise exit 1 even though the HTTP status was
  200 — see below. They are not throttling.

Exit 2 is the "could not measure" case, and it is deliberately distinct
from exit 1: nothing was probed, so there is no per-relay verdict to
report. It is raised by two families of cause:

- **Invalid configuration**: `COUNT` below 1, an empty `PROBE_MODELS`, or a
  non-numeric / non-positive `INTERVAL_S` or `PROBE_TIMEOUT_MS`.
- **An unaddressable topology**: there is no `docker-compose.yml` in the
  working directory, or it carries no `relay` publish line (tunnels-only
  deploy, GitHub Actions runner) and `RELAY_HOST`/`RELAY_BASE_PORT` were
  not both set explicitly.

In that case the prober logs one line naming the cause and exits 2 — it
does not emit per-relay "unreachable" lines, because it never dialed
anything. Setting both `RELAY_HOST` and `RELAY_BASE_PORT` explicitly makes
the pass measure anyway, on a tunnels-only deploy as much as on a mesh one.
See [05](05-troubleshooting-faq.md) for both cases.

`--loop` keeps running forever in the foreground and has no exit code to
read; it logs `loop mode: pass every <INTERVAL_S>s (Ctrl-C to stop)` and
catches per-pass errors so one failure does not end the loop. Without
`--loop` the process is one pass and exits — the shape the systemd unit runs.

## Tunables

Every name below is read by `probe.mjs`, except `BASE_PORT`, which the
generator consumes. The prober has no rotation knobs: there is no
container, no tunnel, and no proxy for it to act on.

| Env | Default | Meaning |
| --- | --- | --- |
| `COUNT` | `10` | Relays probed. Must match the deployed relay count or the pass probes nonexistent relays |
| `RELAY_HOST` | `127.0.0.1` | Address the relay router is dialed on. Derived from the `relay` service's publish line in the generated `docker-compose.yml`, so a mesh install published on a Tailscale IP is probed there. A `*` or `0.0.0.0` bind is dialed as `127.0.0.1` |
| `RELAY_BASE_PORT` | `3101` | Host-published port of relay 1; relay N is probed at `RELAY_BASE_PORT + (N - 1)`. Derived from the same publish line (`"127.0.0.1:3101-3110:3001-3010"` → relay 1 on 3101). Do not set it to the in-container `3000` base — those ports are not host-published |
| `BASE_PORT` | `3000` | The relay app's **in-container** listener base (`server.mjs` listens on 3001-3010 at the default). Read by the generator, **not** by the prober: it moves the container listeners, never the host publish (always 3101-`<3100+COUNT>`) |
| `PROBE_TARGET` | `https://api.kilo.ai` | Upstream the probes go through, as the `x-relay-target` header |
| `PROBE_CHAT_PATH` / `PROBE_RESPONSES_PATH` | `/api/gateway/chat/completions` / `/api/gateway/responses` | Wire paths under `PROBE_TARGET` |
| `PROBE_MODELS` | `nvidia/nemotron-3.5-lightning:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free` | Comma-separated models; one probe each per relay. `PROBE_MODEL` is a single-model override |
| `RESPONSES_MODELS` | `dots-studio/dots-3-note-preview:free` | Models probed via `PROBE_RESPONSES_PATH`; the rest via `PROBE_CHAT_PATH` |
| `GLOBAL_QUOTA_GUARD` | `max(8, COUNT - 1)` (= 9 at `COUNT=10`) | 429-on-this-many-relays = upstream quota on the shared egress (capped at `COUNT`). Reporting threshold only — it does not change the exit code |
| `SPEED_MODEL` | `nvidia/nemotron-3.5-lightning:free` | Model whose latency ranking is logged |
| `PROBE_TIMEOUT_MS` | `30000` | Per-probe timeout, also the shared-egress read |
| `INTERVAL_S` | `300` | `--loop` seconds between passes |
| `KEEP_COLD_LOG` | stdout only | Optional file log, appended in addition to stdout |
| `KEEP_COLD_LOG_MAX_BYTES` | `2 MiB` | File is trimmed once it passes this size |
| `KEEP_COLD_LOG_KEEP_BYTES` | `200 KiB` | Size of the newest slice kept when trimming |

Note on the log variables: they still carry the `KEEP_COLD_LOG` names because
the systemd units that supply them do. The path is set in
`systemd/warp-keep-cold.service` to `probe.log`; the unit comment notes that
earlier installs wrote `keep-cold.log`, the filename of the retired WARP-era
prober.

The prober resolves `RELAY_HOST`/`RELAY_BASE_PORT` once per run, before
any probe: with both unset it reads `docker-compose.yml` from the working
directory (the systemd unit sets `WorkingDirectory` to the checkout) and
takes the bind and the host base of the `relay` publish line from it. If the
file is absent, or carries no `relay` publish line — tunnels-only deploy,
GitHub Actions runner, bare checkout — there is nothing to dial, so the
pass logs one line naming the cause and exits `2` ("could not measure")
rather than probing dead ports and reporting every relay unreachable.
Setting both `RELAY_HOST` and `RELAY_BASE_PORT` explicitly makes the pass
measure anyway. `COUNT` must match the deployed pool: the units and the
wizard both carry it explicitly.

## Never-restart rule

The prober never restarts `tunnel-N`, `relay`, or anything else — it makes no
docker calls at all. Public tunnel URLs and in-flight connections survive
every pass. Do not add remediation here: under direct egress a restart cannot
change the egress IP, so the only remedies for a per-IP limit are a redeploy
or a new GitHub Actions run.

## Observed example

One pass over this host on 2026-10-20 with no pool running, showing the shape
of the output and the summary line (`clean` counts relays with neither a
throttle nor a failure):

```text
[2026-10-20T09:22:43.079Z] probing 10 relay(s) x 3 model(s) via 127.0.0.1:3101..3110 (direct egress — detection only, nothing is restarted)
[2026-10-20T09:22:43.101Z] egress unknown (relay #1 health check unreachable at 127.0.0.1:3101)
[2026-10-20T09:22:43.114Z] #1 nvidia/nemotron-3.5-lightning:free unreachable — fetch failed
[2026-10-20T09:22:43.114Z] #1 cohere/north-mini-code:free unreachable — fetch failed
[2026-10-20T09:22:43.114Z] #1 dots-studio/dots-3-note-preview:free unreachable — fetch failed
…
[2026-10-20T09:22:43.115Z] clean 0/10 relay(s) | unreachable: #1 #2 #3 #4 #5 #6 #7 #8 #9 #10
```

That pass exits 1: the router was dialed and every relay refused the
connection, so the pool failed the pass even though nothing was throttled.
The default dial target `127.0.0.1:3101…3110` comes from the compose publish
line above; every probe is a plain HTTP request against the host-published
router port. A tunnels-only deploy has no publish line to read, so there the
pass logs one line and exits 2 instead — see [Exit codes](#exit-codes).

## Logs

Stdout always (journald: `journalctl -u warp-keep-cold.service`);
`KEEP_COLD_LOG=/path/probe.log` additionally appends to a self-rotating file
(2 MiB cap, newest 200 KiB kept). The rotation runs before each append and
never breaks a pass — a log failure is swallowed. In `--loop` mode a pass
that throws logs `pass failed: <message>` and the loop continues after
`INTERVAL_S`.
