# warp-relay-pool

Self-hosted Docker/WARP alternative to the Workers/Deno/Vercel relays
[pi-freeflow](https://github.com/trefeon/pi-freeflow)'s `/freeflow deploy` creates:
N isolated relays, each with its own WARP egress
address and its own stable client URL. A keep-cold prober rotates only the
WARP clients behind throttled relays, so client pool URLs never change.

```
[OMP/Pi via pi-freeflow] ──► http://<tailscale-ip>:310N (mesh-VPN, recommended)
                          └─► <RELAY-N-URL> (Quick Tunnel, fallback)
      ──► [relay :300N] ──► [warp-N SOCKS :1080] ──► [upstream API, egress <EGRESS-IP>]
```

One `warp-N` per relay (own identity, own throttle budget), one `relay`
process (allowlist-gated proxy on `300N`, SSE streaming, health check
without target header via its own WARP dispatcher). Quick-Tunnel
`cloudflared` containers (`tunnel-N → http://10.244.0.100:300N`) are
optional, for hosts without VPN (`--with-tunnels`).
Bridge `10.244.0.0/16`, relay app fixed at `10.244.0.100` — see
`docker-compose.yml` / `generate-compose.sh`.

> Client requirement: mesh-VPN `http://` relay URLs need a pi-freeflow
> build with mesh-VPN peer relay support (plain-http URLs on private
> tailnet/host addresses are rejected by older https-only builds).
> Without that, use the Quick-Tunnel path below.

## One-Command Auto Setup (Recommended)

Run the setup wizard on your Linux VPS:

```bash
git clone https://github.com/trefeon/warp-relay-pool.git
cd warp-relay-pool
./setup.sh
```

Or run non-interactively with auto-detected recommendations:
```bash
./setup.sh -y
```

The wizard automatically:
- Inspects VPS memory, CPU cores, and Tailscale connectivity.
- Recommends the safe relay count based on VPS capabilities.
- Uses the minimal **MicroWARP** engine (`warp-lite`: ~1.8 MiB RAM/node vs ~100 MiB standard).
- Generates `docker-compose.yml` and starts the containers.
- Verifies WARP connectivity and displays your `/freeflow add` commands.
- Installs the `warp-keep-cold.timer` systemd service.

---

## Manual Quickstart (mesh-VPN direct)

```bash
# 1. Start the pool (10 relays by default, 11 containers: 10 WARP + 1 relay)
./generate-compose.sh 10
docker compose up -d --build

# 2. Read live state: port, egress IP, client commands
./get-status.sh

# 3. Wire the pool (one line per relay, from step 2)
#    /freeflow add http://<tailscale-ip>:310N relay-N
#    then: /freeflow status, /freeflow list, /freeflow test
#    modes: /freeflow auto | /freeflow spread (parallel subagents) | /freeflow off
```

Mesh-VPN URLs are static: container restarts, daemon reboots, and relay
rebuilds never change them. No remote hop either — probes typically answer
in half the time of a tunnel round-trip.

## Fallback: Quick Tunnels (hosts without VPN)

```bash
./generate-compose.sh 10 --with-tunnels
docker compose up -d --build
./get-status.sh   # prints live tunnel URLs + /freeflow add lines
```

Tunnels are ephemeral by design: any `tunnel-N` restart mints a new edge
URL, so re-run `./get-status.sh` and re-paste the client lines after one.
Never restart `tunnel-N` for a throttled relay — that trades a per-egress
429 for pool-wide URL churn. The generator never emits `depends_on: - relay`
on tunnels, so relay rebuilds can't cascade-restart them.

Client: [pi-freeflow](https://github.com/trefeon/pi-freeflow) — the OMP/Pi
extension (npm `pi-freeflow`) — failover behavior lives there, see its
[relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md).
Upstream targets are OpenCode Zen (`https://opencode.ai`) and Kilo
(`https://api.kilo.ai`). Request shape: `x-relay-target` (origin, absent
= health check) plus `x-relay-path` (default `/`), gated by the allowlist
(`RELAY_ALLOWED_TARGETS` env, default `https://opencode.ai`, `https://api.kilo.ai`)
Full lifecycle, deploy, client wiring, operations, FAQ: [`docs/`](docs/).

## Dual-purpose WARP stack

Each `warp-N` also publishes its raw proxy on host port `<10800+N>`
(`10801`–`10810` at COUNT=10), so co-hosted consumers can use the same
egress IPs directly (from sibling containers via the Docker gateway
`<docker-gateway>:1080N`), zero conflict with the relay router:

- Raw proxy: `<docker-gateway>:10801..10810` → `warp-N:1080`
- Relay router: `<tailscale-ip>:3101..3110` → relay `:3001..3010`

Port-collision note: pick host ranges clear of local services. The relay
router defaults to `3101`– instead of `3001`-on-host because host port
`3002` is commonly claimed (example: a local dev API on `:3002`); adjust
the `ports:` line if your host differs.

## Why one port per relay (not a single load balancer)

- **Reasoning-issuer affinity:** reasoning models return encrypted
  reasoning decryptable only by the issuing egress IP. The client pins
  follow-up turns to the issuing relay; a blind load balancer would route
  turn 2 to a different egress and break the conversation.
- **Failure isolation:** one 429 cools down one relay; the other nine keep
  serving without dropping turns.
- **Hedging:** a stalled relay can be raced against a second egress path —
  impossible behind a single endpoint.

## Rotation rule: warp-only

Throttled relay → restart only its `warp-N`
(`docker restart warp-relay-warp-N`), or let the keep-cold timer do it:

```bash
node keep-cold.mjs --once
sudo cp systemd/warp-keep-cold.{service,timer} /etc/systemd/system/
# edit User/WorkingDirectory paths to your checkout first, then:
sudo systemctl enable --now warp-keep-cold.timer
```

Never restart `tunnel-N` or `relay` for a hot egress — tunnel restarts
mint new edge URLs and break every configured client line.

Rebuild, don't restart: the image is `COPY`-baked, so after editing
`server.mjs`: `docker compose build relay && docker compose up -d relay`.

## File map

| File | Role |
| ---- | ---- |
| `setup.sh` | Interactive and non-interactive auto-setup wizard with VPS hardware sizing |
| `server.mjs` | Relay app: allowlist proxy, one listener per `300N`, SSE/no-buffer streaming |
| `keep-cold.mjs` | Two-tier 429 prober / rotator for MicroWARP backends (`--once` or `--loop`) |
| `docker-compose.yml` | N × MicroWARP + relay app; tunnels appended only by `--with-tunnels` |
| `Dockerfile` / `package.json` | Relay image (COPY-baked) / deps |
| `generate-compose.sh` | Regenerate `docker-compose.yml`: `[count] [--with-tunnels] [--legacy-warp]` |
| `get-status.sh` | Status script: prints mesh-VPN + tunnel URLs, egress IPs, client commands (output stays on host) |
| `systemd/` | systemd service units and timers for keep-cold and logwatch |
| `docs/` | [Numbered guides](docs/) (01–05) |
| `warp-lite/` | Minimal MicroWARP image source (Alpine WireGuard + microsocks, ~1.8 MiB runtime) |

## Privacy rule

No live tunnel URLs, egress IPs, account IDs, tokens, emails, or LAN
addresses are ever committed. `get-status.sh` output stays on the host;
docs use `<RELAY-N-URL>` / `<EGRESS-IP>` / `<tailscale-ip>`. (`*.trycloudflare.com` in docs
means the Quick Tunnel domain pattern, never a live address.)
