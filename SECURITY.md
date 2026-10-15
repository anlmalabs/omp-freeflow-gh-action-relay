# Security Policy

warp-relay-pool pairs Cloudflare WARP egress addresses with public HTTPS
(TryCloudflare Quick Tunnel) or private (Tailscale Mesh-VPN) URLs so AI
coding agents can reach a fixed set of upstream APIs. This document covers
the security model, the repository privacy rules, and how to report issues.

## Security model

**Allowlist gate (`server.mjs`).** Every relayed request must carry an
`x-relay-target` header that exactly matches an entry of
`RELAY_ALLOWED_TARGETS` (default: `https://opencode.ai`,
`https://api.kilo.ai`). Anything else gets `403 Forbidden`. The upstream
request is always `<allowlisted-target>` + `x-relay-path`, so the relay can
only ever reach allowlisted hosts — it is not a general-purpose open proxy.

**No client authentication.** The relay trusts anyone who can reach a
listener. Possession of a relay URL is enough to (a) make allowlisted
upstream requests through that relay's egress IP and (b) read the relay's
current egress IP from the built-in health check (a request without
`x-relay-target` returns the Cloudflare trace for that egress). Treat relay
URLs as sensitive even though Tunnel URLs are public by construction.

**Host-published ports.** `docker-compose.yml` publishes two port families:

- `10800+N` → raw WARP SOCKS5 proxy. No allowlist — a plain egress proxy.
  Bind or firewall these to loopback, your Tailscale interface, or a
  trusted network; never leave them reachable from the internet.
- `3100+N` → relay router (mesh-VPN ingress). Restrict to your mesh/VPN
  or firewall likewise.

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
