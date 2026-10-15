# 02 — Deploy

Runs on a Docker Linux host (needs `NET_ADMIN` for WARP; not Windows).
Prereqs: `docker compose` and `node` (node only for `keep-cold.mjs`).
For mesh-VPN ingress, the host must already be joined to your tailnet.

## Quickest: Automated Setup Wizard

```bash
./setup.sh
```

The wizard inspects VPS RAM/CPU, detects Tailscale, builds the minimal MicroWARP image (~1.8 MiB RAM/node), generates compose, starts containers, and installs the keep-cold systemd timer. Pass `-y` to accept all detected recommendations automatically.

## Manual start (mesh-VPN direct, recommended)

```bash
./generate-compose.sh 10     # pure mode: 10 MicroWARP + 1 relay, no tunnels
docker compose up -d --build # 11 containers (~60 MiB resident total)
./get-status.sh              # ports, egress IPs, mesh-VPN client commands
```
Pure mode publishes two port sets off the host: `warp-N` raw proxies on
`10801`– (for co-hosted consumers, see README) and the relay router on
`3101`– → container `3001`– (mesh-VPN ingress). If a host port in either
range is already claimed (a local dev API on `:3002` is the classic
collision), pick a free range and edit the `ports:` lines before `up`.

## Fallback: Quick Tunnels (hosts without VPN)

```bash
./generate-compose.sh 10 --with-tunnels
docker compose up -d --build # +10 cloudflared (~250 MiB resident total)
./get-status.sh              # also prints live tunnel URLs + client lines
```

`get-status.sh [count]` (default `COUNT` env, else 10) reads live state
off the host: egress IPs from
`docker exec warp-relay-warp-N curl …/cdn-cgi/trace`, tunnel URLs from
`docker logs warp-relay-tunnel-N`. Its output is host-only — never commit it.

## Rescale to N relays

```bash
./generate-compose.sh <N> [--with-tunnels]  # rewrites docker-compose.yml, RELAY_COUNT=N
docker compose up -d --build
```

Topology is fixed by the generator: bridge `10.244.0.0/16`, relay app at
`10.244.0.100`, `tunnel-N → http://10.244.0.100:300N` (tunnels mode only),
`warp-N` on `:1080` (raw proxy on host `<10800+N>`).
`WARP_HOST_N` / `WARP_PORT_N` env overrides exist in `server.mjs` but the
default naming needs no configuration.

## Keep-cold timer (systemd)

```bash
node keep-cold-lite.mjs --once      # one pass now; exit 0 when all clean
sudo cp systemd/warp-keep-cold.{service,timer} /etc/systemd/system/
# edit <USER> paths in both files first, then:
sudo systemctl enable --now warp-keep-cold.timer
```

The service is `Type=oneshot` with `TimeoutStartSec=900` (a pass can
rotate several relays, each waiting for WARP re-handshake) and `flock -n`
so overlapping timer fires never stack. The timer fires every 5 minutes
(`OnCalendar`). Without `--loop`, one pass = one timer fire.
See [04](04-operations-keep-cold.md) for tuning (notably
`GLOBAL_QUOTA_GUARD`).

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
