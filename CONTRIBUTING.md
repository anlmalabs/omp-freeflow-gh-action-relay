# Contributing to warp-relay-pool

Thanks for contributing. This repo is evidence-first: terse, exact
file/symbol/command names, no marketing filler, no invented
versions or benchmarks.

## PR flow

1. Fork, branch from `main`, keep the diff focused.
2. Describe what changed and how you verified it.
3. Wait for review; keep the branch updated until merged.

## Generated-file rule

- `docker-compose.yml` is generated — never edit it by hand.
- Change `generate-compose.sh` (or its inputs) and regenerate:
  `sh generate-compose.sh`
- Commit both the generator change and the regenerated output.

## Privacy rule

- Never commit tunnel URLs (`<RELAY-N-URL>`) or egress IPs (`<EGRESS-IP>`).
- `get-status.sh` output stays host-only; scrub it before pasting.
- Use the `<RELAY-N-URL>` / `<EGRESS-IP>` placeholders in docs and issues.
- Canonical rules, security model, and vulnerability reporting:
  [SECURITY.md](SECURITY.md).

## Smoke check

Run before opening a PR:

```sh
node --check server.mjs
node --check probe.mjs
sh -n generate-compose.sh setup.sh get-status.sh logwatch.sh warp-lite/entrypoint.sh
bash logwatch.test.sh
node --test test/*.test.mjs
docker compose config
```

CI (`.github/workflows/ci.yml`) runs the same gates plus a regeneration
determinism check on `docker-compose.yml`.

Two traps when running these by hand:

- `node` on some dev boxes is a Bun shim. Use `/usr/bin/node` for a syntax
  check — `probe.mjs --check`-style runs through the shim can execute the file
  and report bogus results.
- Never read an exit code through a pipe: `some_cmd | head; echo $?` reports
  `head`'s status, not `some_cmd`'s. Redirect instead: `cmd > log 2>&1; echo $?`,
  and check the log is non-empty before trusting a silent pass.


## Style

- Runtime protocol and topology are frozen (see `README.md`); proposals
  that change them belong in an issue first. Topology is currently direct
  egress: one relay container, N listeners, no per-relay WARP clients, and
  `probe.mjs` only detects — it never restarts a container, because no
  restart can change the shared egress IP. See
  `docs/04-operations-keep-cold.md`.
- Scripts must stay `sh`-portable; the repo runs on a Docker Linux host.
- `.github/workflows/relay-pool.yml` must call
  `sh generate-compose.sh <count> --with-tunnels` so the on-demand pool
  matches the documented deployment.
- No secrets in the tree: `.env*` (except `.env.example`) is ignored.
