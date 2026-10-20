# 05 — Troubleshooting / FAQ

**Mesh-VPN URLs never change.** In default (pure) mode there are no tunnel
containers, so container restarts, daemon reboots, and relay rebuilds keep
every `http://<tailscale-ip>:310N` line working. If a mesh-VPN URL stops
working, the fault is ingress-side (relay app down, host offline, tailnet
split) — check `docker logs warp-relay-app` and host reachability.

**Tunnel URL changed (tunnels mode only).** Expected after any `tunnel-N`
restart or host reboot — Quick Tunnels are ephemeral. Re-run
`./get-status.sh` and re-paste the `/freeflow add <RELAY-N-URL> relay-N`
lines. Relay restarts and prober passes can't cause this: tunnels carry
no `depends_on: - relay`, and `probe.mjs` never touches `tunnel-N` (it makes
no docker calls at all).

**403 `Forbidden target`.** `x-relay-target` is not in the allowlist
(`RELAY_ALLOWED_TARGETS`, default `https://opencode.ai`,
`https://api.kilo.ai`). Fix the header (a trailing `/` is stripped for you)
or set the env and re-run
`./generate-compose.sh <count> [--with-tunnels] && docker compose up -d`
(the generator bakes the allowlist into the relay service environment;
editing `.env` alone rebuilds nothing).

**Mesh-VPN relay URLs skipped by the client.** A pi-freeflow build without
mesh-VPN peer relay support accepts https-only relay URLs and silently
skips plain-http mesh addresses (falling back to direct mode, which
rate-limits). Upgrade the client, or use Quick-Tunnel URLs instead.

**429 across every relay, one model.** Expected shape for direct egress:
all relays share one upstream IP, so a per-IP limit throttles the entire
pool simultaneously instead of one relay. There is no rotation that fixes
it — restarting a container cannot change the host IP. Options: wait for
the upstream window to reset, or redeploy somewhere with a different IP
(a fresh GitHub Actions run gets a new runner IP).
**429 on one relay only** is unusual under direct egress, since all relays
share one IP — it usually means that one request raced an upstream window
rather than a real per-IP limit. Retry, or retry on another relay. Nothing
can clear it for you: under direct egress a restart returns the same IP, so
no restart, container change, or prober pass buys a new address — the only
remedy for a per-IP limit is a different egress (redeploy, or a new GitHub
Actions run). A `probe.mjs` pass reports it — the quota guard only changes
the wording of the report (upstream quota on the shared egress vs per-relay
throttling); any 429 raises exit 1 either way, and no pass can clear it.
See [04](04-operations-keep-cold.md).

**Prober exits 2 — "could not measure".** The pass never dialed a relay, so
it produced no per-relay verdict. Either the configuration is invalid
(`COUNT` below 1, an empty `PROBE_MODELS`, a non-numeric or non-positive
`INTERVAL_S` / `PROBE_TIMEOUT_MS`), or the pool is not host-published: a
tunnels-only deploy has no `relay` publish line in `docker-compose.yml`, so
there is no router address to dial (a GitHub Actions runner has the same
problem). Fix the configuration, or switch to mesh/direct ingress so the
router is published on the host (`3101-3110`), or point the prober at it
explicitly with `RELAY_HOST` and `RELAY_BASE_PORT`. See
[04](04-operations-keep-cold.md).

**Stale code after editing `server.mjs`.** The image is `COPY`-baked:
`docker compose restart relay` re-runs old code. Always
`docker compose build relay && docker compose up -d relay`.

**Containers not ready / `(starting...)` / `(not ready)`.** Check per layer:
`docker logs warp-relay-tunnel-N` (edge URL line appears only once the
tunnel connected), `curl -s http://127.0.0.1:310N/` (relay liveness, mesh
mode only — tunnels mode has no host publish, so use the public URL
`curl -s <RELAY-N-URL>/` instead), and host egress
(`curl -s https://cloudflare.com/cdn-cgi/trace` — relay errors are usually
host-side). One relay red = that listener or the shared fetch path; all
red = the container or host network, since there is no per-relay
egress client to blame.

**Host port already in use.** If `docker compose up` fails binding `310N`
(a local service already claims it — `:3101` collisions are the classic
case), pick a free range and edit the `ports:` lines in
`docker-compose.yml` (or the generator), then `up` again. Client lines use
whatever host ports you publish.

**Multi-stack or systemd failures.** Check systemd logs with
`journalctl -u warp-keep-cold.service -n 50 --no-pager` or `journalctl -u docker`.
If containers stop unexpectedly, inspect exit codes with
`docker inspect <container> --format "exit={{.State.ExitCode}} oom={{.State.OOMKilled}}"`.
