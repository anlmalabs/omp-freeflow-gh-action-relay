# 03 — Use with pi-freeflow (OMP/Pi client)

This pool is the self-hosted Docker/WARP alternative to the relays
`/freeflow deploy` creates — same protocol, same allowlist. Failover
behavior is the client's: see the [relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md).

> Mesh-VPN `http://` relay URLs need a pi-freeflow build with mesh-VPN
> peer relay support (older https-only builds skip them). Without that,
> use the Quick-Tunnel path below.

## Wire the pool (mesh-VPN direct, recommended)

```bash
./get-status.sh
```

Paste one line per relay from its `Mesh-VPN direct commands` section:

```
/freeflow add http://<tailscale-ip>:310N relay-N
```

These URLs are static — they survive container restarts, daemon reboots,
and relay rebuilds, so you paste them once.

## Fallback: Quick Tunnels

When the pool was generated with `--with-tunnels`, `get-status.sh` prints
an extra `Quick Tunnel fallback commands` section (only when tunnel
containers exist). Paste those lines instead:

```
/freeflow add <RELAY-N-URL> relay-N
```

Tunnel URLs are ephemeral: after any `tunnel-N` restart or host reboot,
re-run `./get-status.sh` and re-paste.

Verify, then pick a mode (`spread` for parallel subagents):

```
/freeflow status
/freeflow list
/freeflow test
/freeflow spread
```

Modes: `/freeflow auto` | `/freeflow spread` | `/freeflow off`.
One entry per relay (relay-1 … relay-N); the client fans out across them,
each keeping its own WARP egress.

## Health checks

No `x-relay-target` header = relay answers directly through its own WARP
client. Per-relay, via the bridge (from the Docker host):

```bash
curl -s http://10.244.0.100:3001/          # Relay #1 OK + cdn-cgi/trace body
```

Via the mesh address (same path the client uses):

```bash
curl -s http://<tailscale-ip>:3101/
```

Via the public URL, tunnels mode only (full path — edge, tunnel, relay,
WARP egress):

```bash
curl -s <RELAY-1-URL>/
```

`500 … proxy error` = that relay's `warp-N` SOCKS path is down; check
`tunnel-N` logs only if every relay fails the same way (shared relay app
or host network, not one egress).

## Forwarded request shape

```bash
curl -s -N <RELAY-1-URL>/anything \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /zen/v1/models"
```

`x-relay-target` must be exactly one of the allowlist (`RELAY_ALLOWED_TARGETS`
in `.env.example`, default `https://opencode.ai`, `https://api.kilo.ai`);
anything else is `403`. `x-relay-path` defaults to `/`. To allow another
upstream, set the env, then `docker compose build relay && docker compose up -d relay`
(COPY-baked image — see [02](02-deploy.md)).
