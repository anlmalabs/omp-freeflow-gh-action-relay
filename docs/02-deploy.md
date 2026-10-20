# 02 — Deploy

Runs on any Docker Linux host, or ephemerally on a GitHub Actions runner (see
[GitHub Actions deployment](../README.md#github-actions-deployment)).
Prereqs: `docker compose` only (node only for `keep-cold.mjs`).
For mesh-VPN ingress, the host must already be joined to your tailnet.

## Quickest: Automated Setup Wizard

```bash
./setup.sh
```

The interactive wizard handles everything automatically:
- Checks and installs missing prerequisites (Docker, Docker Compose, Node.js).
- Detects VPS RAM and CPU cores, recommends safe relay limits, and defaults to the **5-relay sweet spot**.
- Builds the relay image — a single `server.mjs` process exposing N listeners, no per-relay egress clients.
- Deploys TryCloudflare Quick Tunnels (public HTTPS URLs, zero client VPN needed) or Mesh-VPN direct.
- Installs the `warp-keep-cold.timer` systemd service — a legacy WARP-era
  prober (unmigrated to direct egress); see
  [04](04-operations-keep-cold.md).
- Prints the copy-paste `/freeflow add` commands ready for your agent.

To run non-interactively with auto-detected recommendations:
```bash
./setup.sh -y
```

**Before deploying anywhere, read the safety warning in
[README.md](../README.md#read-this-first-safety).** Direct egress means the
host or runner IP is what upstreams see, and Quick Tunnel URLs are public.

---

## Manual Deployment

### Option A: TryCloudflare Quick Tunnels (Recommended for public access)

```bash
./generate-compose.sh 5 --with-tunnels
docker compose up -d --build
./get-status.sh              # prints live public tunnel URLs + client commands
```

### Option B: Mesh-VPN Direct (Tailscale)

```bash
./generate-compose.sh 5     # pure mode: relay only, no tunnels
docker compose up -d --build
./get-status.sh              # ports, shared egress IP, client commands
```

`get-status.sh [count]` (default `COUNT` env, else 10) reads live state
off the host: egress IP via the relay health check, tunnel URLs from
`docker logs warp-relay-tunnel-N`. Its output is host-only — never commit it.

### Option C: GitHub Actions (on-demand, ephemeral)

`./generate-compose.sh <count> --with-tunnels` is also what the
`relay-pool` workflow runs on `ubuntu-latest`. Trigger it from the
**Actions → Relay pool → Run workflow** tab, take the URLs from the job
log or the `url` job output, and treat the pool as disposable: it dies
when the job does, and GitHub caps a job at 6 hours. Use a throwaway
account — see the README warning.

## Rescale to N relays

```bash
./generate-compose.sh <N> [--with-tunnels]  # rewrites docker-compose.yml, RELAY_COUNT=N
docker compose up -d --build
```

Topology is fixed by the generator: one relay container exposing listeners
`3001`–`3000+N` (`BASE_PORT+N`), each forwarding directly to the upstream
from the host IP. There is no static bridge address and no bridge ipam
config any more — in tunnels mode `tunnel-N` reaches the relay by Docker
service DNS (`http://relay:300N`); in mesh mode the same ports are published
as `${INGRESS_BIND}:3101-<3100+N>`.
Host binds default to loopback; override with
`INGRESS_BIND=<addr>` (relay router, mesh mode only — tunnels mode does not
host-publish the router at all). Binds are IPv4 only.
`WARP_HOST_N` / `WARP_PORT_N` env overrides exist in `server.mjs` but the
default naming needs no configuration.

A GitHub Actions runner has no per-VPS sizing to respect — pick `count` by
how many parallel `/freeflow` entries you want, not by RAM.

## Keep-cold timer (systemd)

```bash
node keep-cold.mjs --once      # one pass now; exit 0 when all clean
sudo cp systemd/warp-keep-cold.{service,timer} /etc/systemd/system/
# edit paths in the unit to your checkout first, then:
sudo systemctl enable --now warp-keep-cold.timer
```

The service is `Type=oneshot` with `TimeoutStartSec=900` and `flock -n`
so overlapping timer fires never stack. The timer fires every 5 minutes
(`OnCalendar`). Without `--loop`, one pass = one timer fire.
See [04](04-operations-keep-cold.md) for tuning (notably
`GLOBAL_QUOTA_GUARD`).

## Error watcher (logwatch, optional)

`logwatch.sh` scrapes the relay container logs and the keep-cold
journal into `logs/errors.log` (rotated) and writes per-relay/day tallies
for rollover summaries; state lives in `logs/.cursor` / `.last` /
`.events`.

```bash
sudo cp systemd/warp-logwatch.{service,timer} /etc/system/system/  # edit paths first
sudo systemctl enable --now warp-logwatch.timer   # every 2 minutes; flock-guarded
```

Its suite is part of CI: `bash logwatch.test.sh`.

## Rebuild, don't restart

The relay image is `COPY`-baked (`Dockerfile` copies `server.mjs` at build
time). After editing `server.mjs`:

```bash
docker compose build relay && docker compose up -d relay
```

A plain `docker compose restart relay` re-runs the stale baked code.
No edit → no rebuild needed; container `restart: always` covers reboots.
Tunnels (when present) are unaffected: they carry no `depends_on: - relay`,
so relay rebuilds never cascade-restart them.
