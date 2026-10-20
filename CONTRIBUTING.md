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
node --check keep-cold.mjs
sh -n generate-compose.sh setup.sh get-status.sh logwatch.sh warp-lite/entrypoint.sh
bash logwatch.test.sh
node --test test/*.test.mjs
docker compose config
```

CI (`.github/workflows/ci.yml`) runs the same gates plus a regeneration
determinism check on `docker-compose.yml`.

## Style

- Runtime protocol and topology are frozen (see `README.md`); proposals
  that change them belong in an issue first. Topology is currently direct
  egress: one relay container, N listeners, no per-relay WARP clients —
  `keep-cold.mjs` still probes the legacy SOCKS layer and is deliberately
  un-migrated (see `docs/04-operations-keep-cold.md`), so don't "fix" its
  WARP references inside an unrelated PR.
- Scripts must stay `sh`-portable; the repo runs on a Docker Linux host.
- `.github/workflows/relay-pool.yml` must call
  `sh generate-compose.sh <count> --with-tunnels` so the on-demand pool
  matches the documented deployment.
- No secrets in the tree: `.env*` (except `.env.example`) is ignored.
