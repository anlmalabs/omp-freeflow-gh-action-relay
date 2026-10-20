# 01 — Overview: how it works

Self-hosted Docker alternative to the Workers/Deno/Vercel relays
[pi-freeflow](https://github.com/trefeon/pi-freeflow)'s `/freeflow deploy`
creates — the OMP/Pi extension (npm `pi-freeflow`): same
`x-relay-target`/`x-relay-path` protocol, same allowlist
(`https://opencode.ai`, `https://api.kilo.ai`). Client-side failover lives
there — see its [relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md);
this repo documents the relay side only, not its model catalog.

One `relay` process exposes N listeners (`BASE_PORT+N`, default `3001`–`3000+N`).
Each listener forwards requests straight to the upstream via `fetch` from the
deploy host's own IP address — there is no WARP client, no SOCKS proxy, and no
WireGuard hop. Every listener is reachable two ways:

1. **TryCloudflare Quick Tunnels (`--with-tunnels`):** Each relay is exposed as a public HTTPS URL (`https://<hash>.trycloudflare.com`). Zero configuration required—no Cloudflare account, domain, or client-side VPN needed.
2. **Mesh-VPN Direct (Tailscale):** Static private URLs (`http://<tailscale-ip>:310N`) published directly over an encrypted WireGuard mesh network.

```
[OMP/Pi via pi-freeflow] ──► https://<hash>.trycloudflare.com (TryCloudflare, public HTTPS)
                          └─► http://<tailscale-ip>:310N      (Mesh-VPN, static private)
      ──► [relay :300N] ──► [direct fetch, egress = the runner/host IP] ──► [upstream API]
```

Egress is shared: every relay dials upstream from the same host address. That
is the one real trade against the old per-relay WARP design — see
[Why per-relay egress is gone](#why-per-relay-egress-is-gone) below.

## Request lifecycle

1. Client sends the request to the relay URL with two headers
   (`server.mjs`: `x-relay-target`, `x-relay-path`).
2. Relay strips those headers (plus `host`), forwards
   `method + headers + body` to `target + relayPath` with a single shared
   `undici` `Agent` (keep-alive pooling, so cloudflared reuses upstream
   sockets), 5-minute cap (`AbortSignal.timeout(300000)`), client-disconnect
   abort wiring.
3. Relay answers with `cache-control: no-cache`,
   `x-accel-buffering: no`, upstream `content-type` only, `flushHeaders()`
   before the first body byte, then `pipeline(Readable.fromWeb(body), res)`
   — SSE tokens stream, nothing buffers. See `server.mjs`.
4. No `x-relay-target` header = health check: relay fetches
   `https://cloudflare.com/cdn-cgi/trace` and returns `Relay #N OK (direct)`
   followed by the trace body — which shows the one shared egress IP every
   relay in this pool reports. A relay liveness proof, not a load-balancer ping.
5. Target not in the allowlist (`RELAY_ALLOWED_TARGETS`, default
   `https://opencode.ai`, `https://api.kilo.ai`) = `403 {"error":"Forbidden target"}`.

## Header protocol

| Header | Required | Meaning |
| --- | --- | --- |
| `x-relay-target` | no | Upstream origin, trailing `/` stripped. Absent = health check. |
| `x-relay-path` | no | Path appended to target. Default `/`. |

Minimal forward example (relay 1, mesh mode — the compose publish
`127.0.0.1:3101-3110:3001-3010` puts relay `:300N` on host `310N`):

```bash
curl -s -N http://127.0.0.1:3101/v1/models \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /zen/v1/models"
```

## Ingress options: TryCloudflare Quick Tunnels vs Mesh-VPN

### 1. TryCloudflare Quick Tunnels (`--with-tunnels`): Recommended for Easiest Setup

Running `./generate-compose.sh N --with-tunnels` pairs each relay port (`300N`) with a lightweight `cloudflare/cloudflared:latest` container (~18–20 MiB RAM).
- **Zero configuration:** No Cloudflare account, custom domain, API token, or router port-forwarding needed. Cloudflare automatically issues a secure public HTTPS URL ending in `.trycloudflare.com`.
- **Security allowlist:** Although the tunnel URLs are public, the relay router strictly rejects any request whose target is not in `RELAY_ALLOWED_TARGETS` (`opencode.ai`, `api.kilo.ai`) with `HTTP 403 Forbidden`.
- **URL stability:** Tunnels run as independent sibling containers. Rebuilding or restarting the relay app does **not** restart the tunnels or change their URLs — the rotation layer that used to make this delicate is gone, so there is no WARP client restart that could churn a URL either.

### 2. Mesh-VPN Direct (Tailscale)

The `relay` service publishes `${INGRESS_BIND}:3101-<3100+N>` → container `3001-<3000+N>`, so `http://<tailscale-ip>:310N` reaches relay `:300N` over your private encrypted Tailscale network. `INGRESS_BIND` defaults to `127.0.0.1`; the wizard (`setup.sh`) sets it to the VPS Tailscale IP for mesh installs, and manual installs pass it explicitly (`INGRESS_BIND=<tailscale-ip> ./generate-compose.sh N`).
- **Static:** URLs never change across container recreations, host reboots, or updates.
- **Private:** No traffic passes over public tunnel endpoints.
## Why one port per relay (not a single load balancer)

- **Reasoning-issuer affinity:** reasoning models return encrypted
  reasoning decryptable only by the issuing relay. The client pins
  follow-up turns to the issuing relay; a blind load balancer would route
  turn 2 to a different path and break the conversation.
- **Failure isolation:** one listener going down affects one relay while
  the rest keep serving — behind one endpoint, a single relay fault
  poisons everything.
- **Hedging:** the client can race a stalled relay against a second relay;
  a single endpoint gives it nothing to race with.
- **One client URL each:** N relays means N stable addresses for
  `/freeflow add`, so the client can fan subagents out across them.

## Why per-relay egress is gone

The old design gave each relay its own MicroWARP client
(`warp-lite`, `NET_ADMIN`) with its own egress IPv6 address, so upstream
per-IP throttling (HTTP 429) hit one relay rather than the pool, and
keep-cold rotated a hot `warp-N` for a fresh `<EGRESS-IP>` while every
client URL kept working.

That layer is deliberately removed. Direct egress has no per-relay egress
address to own, and every relay now egresses from the single host or
runner IP. The consequences, plainly:

- **No egress diversity.** All relays share one IP, so an upstream 429 wave
  hits the whole pool at once — the same limit throttles every relay, and
  no amount of restarting buys a new address. Where the WARP design survived
  a per-IP throttle, this one rides it out.
- **No rotation.** Restarting a container cannot change the egress IP, so a
  per-IP 429 has no escape. `keep-cold.mjs` is still WARP-era code — its
  rotations target `warp-N` containers that no longer exist — so detection is
  the only thing it can still offer, and only after you point its
  `RELAY_HOST` at a reachable relay. See [04](04-operations-keep-cold.md).
- **Much smaller footprint.** No WireGuard, no microsocks, no `NET_ADMIN`:
  one container, and a pool that fits anywhere a single relay would.
