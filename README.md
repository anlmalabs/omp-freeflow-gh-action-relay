# warp-relay-pool

Self-hosted Docker direct-egress relay pool for AI coding agents ([pi-freeflow](https://github.com/trefeon/pi-freeflow), OMP, Pi).

Provides N relay listeners paired with public HTTPS URLs via **Cloudflare Quick Tunnels (TryCloudflare)** or private static URLs via **Tailscale Mesh-VPN**. Each relay forwards requests straight to the upstream from the host's own IP — there is no WARP client, no SOCKS proxy, and no per-relay egress address. The background prober (`probe.mjs`, run by the `warp-keep-cold.timer` systemd timer) is **detection only**: it probes every relay with a real streaming inference request per model, reports throttling per relay+model, and touches no container, tunnel, or the relay app. It dials the relays from the host, so it only measures a pool whose relay router is published there (mesh/direct ingress); in tunnels mode it has no address for the relays and exits 2 ("could not measure"). Exit codes: 0 = every probed relay/model answered 200, 1 = at least one was throttled or failed, 2 = the pool could not be measured. **This repo is on hold** — see the note below.

```
[OMP / Pi via pi-freeflow]
          │
          ├── TryCloudflare (Public HTTPS, zero client VPN) ──► https://<hash>.trycloudflare.com
          └── Tailscale (Private Mesh-VPN direct)           ──► http://<tailscale-ip>:310N
                    │
                    ▼
          [relay router :300N]
                    │  (per-port allowlist forward, direct fetch)
                    ▼
          [Upstream API (opencode.ai / api.kilo.ai) — egress = the host/runner IP]
```

> [!WARNING]
> ## Read this first: safety
>
> **Do NOT deploy this on your main GitHub account.** The GitHub Actions path
> below runs an unauthenticated, publicly-addressable proxy from a GitHub-hosted
> runner under your account. Use a throwaway account only.
>
> - **Quick tunnel URLs are public.** Anyone who obtains a `*.trycloudflare.com`
>   URL can use that relay. The allowlist (`RELAY_ALLOWED_TARGETS`, default
>   `https://opencode.ai`, `https://api.kilo.ai`) limits what they can reach —
>   your upstream API keys, any other host, or raw internet egress are not
>   reachable through it — but it is not a secret, so treat a leaked URL as a
>   shared resource to revoke by ending the job.
> - **The runner's IP is exposed to upstreams.** Direct egress means every
>   upstream request originates from the GitHub runner's public IP. Expect that
>   address to appear in upstream logs, and expect it to be flagged or throttled
>   as datacenter/CI traffic.
> - **The pool is ephemeral.** It lives only as long as the workflow job. GitHub
>   caps a job at 6 hours; cancel the run or hit the cap and the pool, the
>   containers, the volumes, and all tunnel URLs are gone.
> - **No egress diversity.** Every relay shares the single runner IP. Unlike the
>   original WARP VPS design (where each relay had its own egress address), an
>   upstream per-IP 429 hits the *whole pool at once*, and restarting anything
>   cannot buy a new IP. This pool spreads concurrency, not upstream identity.

> [!NOTE]
> ## On hold
>
> **This repo is on hold.** The code is merged and working — the relay pool,
> the tunnels and the client setup are all functional as they stand — but it
> is parked: no further work on it is planned for now, and nothing here will
> be extended, reworked or maintained until it is picked back up.
>
> That includes the throttle prober (`probe.mjs` and the
> `warp-keep-cold.timer` that runs it): detection only, exit codes 0 = clean,
> 1 = throttled or failed, 2 = could not measure. The wizard installs the
> timer in mesh/direct ingress mode only, since in tunnels mode the prober
> has no host address for the relays.
>
> Deployments that already exist keep working. Nothing in the pool depends on
> the prober, and the only thing it ever did was report upstream 429s —
> which, under direct egress, no restart can clear anyway.
>
> Prober details and tunables: [docs/04](docs/04-operations-keep-cold.md).

---

## Quickstart: One-Command Auto Setup

Deploy on any Linux VPS (Ubuntu, Debian, Alpine, Fedora, CentOS):

```bash
git clone https://github.com/trefeon/warp-relay-pool.git
cd warp-relay-pool
./setup.sh
```

Or run non-interactively with auto-detected sizing recommendations:
```bash
./setup.sh -y
```

### What the Setup Wizard Does:
1. **Prerequisite Check & Auto-Install:** Verifies and automatically installs Docker, Docker Compose, and Node.js if missing.
2. **Hardware Sizing:** Detects VPS RAM and CPU cores, recommends safe relay limits, and defaults to the **5-relay sweet spot**.
3. **Relay Image Build:** Builds the single-process relay router — N listeners, one container, no per-relay egress client.
4. **TryCloudflare Tunnel Wiring:** Automatically exposes each relay on a public HTTPS URL without requiring any Cloudflare account, domain name, or open inbound firewall ports.
5. **Keep-Cold Service:** Installs and enables the `warp-keep-cold.timer` systemd service to probe relays for HTTP 429 every 5 minutes — detection only: it reports throttling per relay+model and restarts nothing, since direct egress gives it no other IP to rotate to (see [docs/04](docs/04-operations-keep-cold.md)). The prober reaches the relays over the host, so it needs the relay router published there: the wizard installs the timer in mesh/direct ingress mode and skips it for Quick Tunnels, where a pass would exit 2 ("could not measure").
6. **Client Commands:** Prints ready-to-paste `/freeflow add` commands directly into your terminal.

---

## Sizing: Why 5 Relays is the Sweet Spot

For most users and developers running parallel coding subagents, **5 relays** is optimal:
- **5 Independent Client URLs:** N relays give N stable addresses for `/freeflow add`, so parallel subagents can be fanned out across them.
- **Ultra-Low Memory Consumption:**
  - With **TryCloudflare Quick Tunnels**: ~110 MB total RAM (one relay container plus tunnels).
  - With **Tailscale Mesh-VPN**: ~50 MB total RAM.
- **One Shared Egress IP:** All relays dial upstream from the same host address. That is the point of the design — it also means a per-IP upstream 429 throttles the entire pool at once, so size by concurrency needs rather than by rate-limit headroom.

| VPS Plan | Ingress Mode | Recommended Relays | Total Stack Memory |
|---|---|---|---|
| **512 MB VPS** | TryCloudflare Tunnels | 5 relays | ~110 MB |
| **512 MB VPS** | Tailscale Mesh-VPN | 5 – 10 relays | ~50 – 60 MB |
| **1 GB VPS** | TryCloudflare Tunnels | 5 – 10 relays | ~110 – 150 MB |
| **2 GB+ VPS** | TryCloudflare Tunnels | 10 – 20 relays | ~110 – 270 MB |

---

## GitHub Actions deployment

Run the pool on-demand on a GitHub-hosted runner, with no VPS at all.
Everything is destroyed when the job ends.

1. Go to **Actions → Relay pool → Run workflow**.
2. Set `count` (integer, **1–20**, default `5`) — how many relays to spin up.
3. Run it. The workflow:
   - generates `docker-compose.yml` with `sh generate-compose.sh <count> --with-tunnels`,
   - builds and starts the stack with `docker compose up -d --build`,
   - waits for each `tunnel-N` to log its quick-tunnel URL, then prints one
     `https://<hash>.trycloudflare.com` URL per relay to the job log and as the
     job output (`relay-pool` job → `url`),
   - holds the pool open until the job timeout or a manual cancel.

Copy the printed lines straight into your agent chat:

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
/freeflow add https://<hash-3>.trycloudflare.com relay-3
/freeflow add https://<hash-4>.trycloudflare.com relay-4
/freeflow add https://<hash-5>.trycloudflare.com relay-5
```

| Property | Value |
| --- | --- |
| Trigger | `workflow_dispatch` (manual, from the Actions tab) |
| Relay count input | `count`, integer, default `5`, valid range `1`–`20` |
| Runner | `ubuntu-latest` |
| Job timeout | 360 minutes (GitHub's hard job cap is 6h) |
| Concurrency | One pool at a time (`relay-pool` group, no cancel-in-progress) |
| Tunnel URLs | Printed to the job log and exposed as the `url` job output |
| Lifetime | Ephemeral — dies with the job, URLs change every run |
| Egress | The runner's single public IP, shared by all relays |

Because the job is the pool's entire lifetime, cancelling the run tears the
pool down immediately; that is also the way to revoke the public URLs. Only
one pool runs at a time: a second dispatch queues behind the current job
rather than interrupting it.

Practical notes:
- `count` above 5 has no memory benefit to trade against — GitHub runners are
  large. Pick it by how many `/freeflow add` entries you want.
- The workflow's `--with-tunnels` mode does not publish the relay router to the
  host at all, so `http://127.0.0.1:310N` is unavailable on a runner; the cloudflared
  URLs are the only ingress.
- A fresh run gets a fresh runner IP, which is the only way this pool changes
  upstream identity.

---

## Connecting to Your Agent (`pi-freeflow`)

Once `./setup.sh` completes, copy the printed commands and paste them into your OMP or Pi agent chat:

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
/freeflow add https://<hash-3>.trycloudflare.com relay-3
/freeflow add https://<hash-4>.trycloudflare.com relay-4
/freeflow add https://<hash-5>.trycloudflare.com relay-5
```

Then manage your pool in agent chat:
- `/freeflow status` — check all configured relays and their active health
- `/freeflow test` — run real upstream streaming inference tests across all relays
- `/freeflow spread` — distribute parallel subagent tasks across all relays simultaneously

---

## Security Model (Safe for Public Internet)

Even when exposed over public TryCloudflare HTTPS URLs, the relay is strictly protected:
- **Strict Target Allowlist:** The relay router (`server.mjs`) strictly enforces `RELAY_ALLOWED_TARGETS` (`https://opencode.ai`, `https://api.kilo.ai` by default).
- Requests to any other origin (or malicious targets) return **HTTP 403 Forbidden** immediately.
- Only inference streaming requests conforming to the `x-relay-target` protocol are forwarded.

---

## Manual Deployment

If you prefer manual control over the compose generation and lifecycle:

### Option A: TryCloudflare Quick Tunnels (Zero VPN required)
```bash
./generate-compose.sh 5 --with-tunnels
docker compose up -d --build
./get-status.sh
```

### Option B: Tailscale Mesh-VPN Direct
```bash
./generate-compose.sh 5
docker compose up -d --build
./get-status.sh
```

---

## Rotation Rule: Never Restart `tunnel-N`

Relay URLs are only stable if the tunnels stay up. Keep this rule for any
manual troubleshooting:

```bash
docker ps --filter name=warp-relay-tunnel-   # tunnels to leave alone
```

- **Never restart `tunnel-N`:** restarting a tunnel mints a new
  `.trycloudflare.com` URL, breaking every configured client line. There is no
  per-relay egress client to rotate instead — direct egress means a restart
  cannot change the upstream IP.
- **Never restart `relay`:** it drops active connections across all relays.
- `docker compose restart relay` is never the fix for stale code either: the
  image is `COPY`-baked, so rebuild after editing `server.mjs`
  (`docker compose build relay && docker compose up -d relay`).
- The automated monitor (`probe.mjs`) touches neither `tunnel-N` nor `relay`
  — it makes no docker calls at all — so public URLs and in-flight
  connections survive a pass. It also has nothing to gain from touching
  them: direct egress means a restart cannot change the upstream IP, so a
  pass reports throttling rather than fixing it. See
  [docs/04](docs/04-operations-keep-cold.md).

To run a single probe pass manually:
```bash
node probe.mjs --once
```
One pass exits 0 when every probed relay/model answered 200, 1 when at least
one was throttled (429) or failed, and 2 when the pool could not be measured
— for example in tunnels mode, where the relays have no host address to
probe.

---

## Egress model: direct, not WARP

This pool used to pair each relay with its own Cloudflare WARP client for a
distinct egress IP. That layer is gone:

```
old:  relay :300N ──► warp-N SOCKS :1080 ──► Cloudflare ──► upstream   (per-relay egress IP)
now:  relay :300N ──────────────────────────► upstream                (one shared host/runner IP)
```

The trade-off is the whole design:

| | Old (per-relay WARP) | Now (direct egress) |
| --- | --- | --- |
| Egress IPs | N distinct addresses | 1 shared host/runner address |
| A per-IP upstream 429 | One relay throttled | Whole pool throttled |
| Recovery | Rotate that relay's WARP client | None — restarting cannot change the IP |
| Per-relay memory | ~1.8 MiB (WireGuard + microsocks) | 0 |
| Runner-friendly | No (`NET_ADMIN`, WARP handshake) | Yes (plain containers) |
| Attack surface | Raw SOCKS proxies + router listeners | Router listeners only |

What is unchanged: the allowlist, the `x-relay-target` header protocol,
per-port routing, and SSE/no-buffer streaming. What remains is N stable
client URLs with a strict allowlist behind them — see
[docs/01](docs/01-overview-how-it-works.md) for why one port per relay.

---

## File Map

| File | Role |
| ---- | ---- |
| `setup.sh` | Interactive and non-interactive auto-setup wizard with VPS hardware sizing |
| `server.mjs` | Relay router: allowlist proxy, one listener per `300N`, SSE/no-buffer streaming |
| `probe.mjs` | Throttle detector for the relay pool (`--once` or `--loop`): one streaming inference request per model per relay, reports per relay+model, restarts nothing; needs the host-published router (mesh mode); exit 0 = clean, 1 = throttled/failed, 2 = could not measure — see [docs/04](docs/04-operations-keep-cold.md) |
| `docker-compose.yml` | Relay app with N listeners; tunnels appended only by `--with-tunnels` |
| `Dockerfile` / `package.json` | Relay image (COPY-baked) / dependencies |
| `generate-compose.sh` | Regenerate `docker-compose.yml`: `[count] [--with-tunnels]` |
| `get-status.sh` | Status script: prints public tunnel URLs, the shared egress IP, client commands |
| `systemd/` | systemd service units and timers for keep-cold and logwatch |
| `docs/` | Step-by-step technical guides (01–05) |
| `.github/workflows/` | CI checks, plus `relay-pool.yml` for on-demand ephemeral pools on a runner |

---

## Security & Privacy

Repository privacy rules — no live tunnel URLs, egress IPs, account IDs, tokens, emails, or private host addresses are ever committed; docs use `<RELAY-N-URL>` / `<EGRESS-IP>` / `<tailscale-ip>`, and `*.trycloudflare.com` always means the Quick Tunnel domain pattern — plus the full security model and vulnerability reporting live in [SECURITY.md](SECURITY.md).
