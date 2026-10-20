# Security Policy

warp-relay-pool exposes relay listeners under public HTTPS
(TryCloudflare Quick Tunnel) or private (Tailscale Mesh-VPN) URLs so AI
coding agents can reach a fixed set of upstream APIs. Egress is direct:
every request leaves from the host's own IP, so all relays in a pool share
one upstream address. This document covers the security model, the
repository privacy rules, and how to report issues.

## Security model

**Allowlist gate (`server.mjs`).** Every relayed request must carry an
`x-relay-target` header that exactly matches an entry of
`RELAY_ALLOWED_TARGETS` (default: `https://opencode.ai`,
`https://api.kilo.ai`). Anything else gets `403 Forbidden`. The upstream
request is always `<allowlisted-target>` + `x-relay-path`, so the relay can
only ever reach allowlisted hosts — it is not a general-purpose open proxy.

**No client authentication.** The relay trusts anyone who can reach a
listener. Possession of a relay URL is enough to (a) make allowlisted
upstream requests through the pool's egress IP and (b) read that egress IP
from the built-in health check (a request without `x-relay-target` returns
the Cloudflare trace). Treat relay URLs as sensitive even though Tunnel URLs
are public by construction.

**Shared egress is not anonymity.** With no WARP layer, upstreams see one
address — the VPS IP, or on a GitHub Actions pool the runner's public IP.
Upstream 429s apply per-IP, so one limit throttles every relay in the pool at
once. Nothing here rotates the IP: the only way to change upstream identity
is to redeploy elsewhere (for a runner, start a new run).

**Host-published ports.** The relay router binds to `127.0.0.1` by
default: nothing is reachable from the internet unless you opt in.

- `3100+N` → relay router (mesh-VPN ingress), published only in mesh mode;
  `setup.sh` sets `INGRESS_BIND` to the VPS Tailscale IP. In tunnels mode
  it is not host-published at all — tunnels reach it over the compose
  network by Docker service DNS (`http://relay:300N`).
- Overrides: `INGRESS_BIND=<addr> ./generate-compose.sh N` (default
  `127.0.0.1`). Binds are IPv4 only (an IPv6 value is rejected at
  generation time).
- The former `10800+N` raw WARP SOCKS5 proxies and their `WARP_BIND` /
  `SOCKS_HOST` overrides are gone with the WARP layer. That port family was
  an unauthenticated, un-allowlisted egress proxy; the relay router behind
  `3100+N` is the only remaining host-facing surface.
- On a GitHub Actions pool, neither port family is published on the runner:
  cloudflared URLs are the only ingress, and they are public by construction.

Docker publishes ports via DNAT before host `INPUT` rules are evaluated, so
a plain `ufw`/`firewalld` setup does not filter these mappings; use
`DOCKER-USER` rules if you deliberately expose anything.

## Repository privacy rules

Never commit, paste into issues/PRs, or put in docs:

1. Live tunnel URLs (`https://<random>.trycloudflare.com`).
2. Egress IPs, Tailscale/tailnet IPs, or private host addresses.
3. Account IDs, API tokens, or personal emails.
4. `get-status.sh` output — it stays on the host; scrub before sharing
   anywhere.

Docs use placeholders only: `<RELAY-N-URL>` / `<EGRESS-IP>` /
`<tailscale-ip>` / `<hash-N>.trycloudflare.com`. `*.trycloudflare.com` in
this repository always means the Quick Tunnel domain pattern, never a live
address. Real addresses live only in host `get-status.sh` output and local
`.env` files.

Supporting measures already in the tree:

- `.gitignore` excludes `.env*` (except `.env.example`), `accounts/`,
  `warp*.conf`, `wgcf-*.{conf,toml}`, `*-reg.json`, `backups/`, `devdocs/`,
  and `reference/`.
- The maintainer's pre-push workflow scans the tree with `gitleaks` and
  `trufflehog`; keep your own branches free of anything on the list above.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: **Security tab → Report a
vulnerability**
(https://github.com/trefeon/warp-relay-pool/security/advisories/new).
Do not open a public issue for allowlist bypass, secret exposure, or
anything exploitable. Include the affected file/commit, a reproduction,
and the impact. Only the latest `main` is supported.
