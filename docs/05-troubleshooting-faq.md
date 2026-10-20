# 05 — Troubleshooting / FAQ

**Mesh-VPN URLs never change.** In default (pure) mode there are no tunnel
containers, so container restarts, daemon reboots, and relay rebuilds keep
every `http://<tailscale-ip>:310N` line working. If a mesh-VPN URL stops
working, the fault is ingress-side (relay app down, host offline, tailnet
split) — check `docker logs warp-relay-app` and host reachability.

**Tunnel URL changed (tunnels mode only).** Expected after any `tunnel-N`
restart or host reboot — Quick Tunnels are ephemeral. Re-run
`./get-status.sh` and re-paste the `/freeflow add <RELAY-N-URL> relay-N`
lines. Relay restarts and keep-cold passes can't cause this: tunnels carry
no `depends_on: - relay`, and keep-cold never touches `tunnel-N`.

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
rather than a real per-IP limit. Retry, or retry on another relay; a keep-cold
pass cannot clear it, because its rotation targets containers that no longer
exist (see [04](04-operations-keep-cold.md)).

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
