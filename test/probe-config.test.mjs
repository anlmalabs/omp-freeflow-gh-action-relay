// Unit tests for probe.mjs's configuration helpers.
//
// The prober's CLI behaviour must stay untouched by being importable, so
// these tests cover the pure parts only: how the dial target is resolved
// from the generated docker-compose.yml, how a wildcard bind is mapped to a
// dialable address, which topologies cannot be measured at all, and which
// configuration mistakes are refused before a pass starts.
//
// Regression coverage for: BASE_PORT (the relay app's IN-CONTAINER base)
// being read as the host-published port base, a wildcard bind being dialed
// verbatim, and a config that produces a green pass over an unprobed pool.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  configErrors,
  dialTarget,
  parseRelayPorts,
  quotaGuard,
  resolveTopology,
} from "../probe.mjs";

/** A mesh/direct-ingress compose file: the relay router is host-published. */
const COMPOSE_MESH = `services:
  relay:
    build: .
    container_name: warp-relay-app
    environment:
      - RELAY_COUNT=10
      - BASE_PORT=3000
    ports:
      - "127.0.0.1:3101-3110:3001-3010"
`;

/** A tunnels-only compose file: no relay publish line, so no host address. */
const COMPOSE_TUNNELS = `services:
  relay:
    build: .
    container_name: warp-relay-app
    environment:
      - RELAY_COUNT=10
      - BASE_PORT=3000
  tunnel-1:
    image: cloudflare/cloudflared:latest
`;

test("the relay base port comes from the compose publish line", () => {
  const published = parseRelayPorts(COMPOSE_MESH);
  assert.equal(published.hostBase, 3101, "relay 1 is published on 3101");
  assert.equal(published.count, 10);

  const topology = resolveTopology({}, COMPOSE_MESH);
  assert.equal(topology.error, undefined);
  assert.equal(topology.host, "127.0.0.1");
  assert.equal(topology.basePort, 3101);
});

test("an explicit RELAY_BASE_PORT overrides the publish line", () => {
  const topology = resolveTopology({ RELAY_BASE_PORT: "4100" }, COMPOSE_MESH);
  assert.equal(topology.basePort, 4100);
  assert.equal(topology.host, "127.0.0.1");
});

test("BASE_PORT is inert: it is the relay app's in-container base", () => {
  const withBasePort = resolveTopology({ BASE_PORT: "3000" }, COMPOSE_MESH);
  const without = resolveTopology({}, COMPOSE_MESH);
  assert.deepEqual(withBasePort, without);
  // The old prober read BASE_PORT as the host base and dialled 3000..3009
  // while the host publishes 3101..3110.
  assert.equal(withBasePort.basePort, 3101);
});

test("a wildcard bind is dialed as loopback, any other bind as-is", () => {
  assert.equal(dialTarget("0.0.0.0"), "127.0.0.1");
  assert.equal(dialTarget("*"), "127.0.0.1");
  assert.equal(dialTarget(""), "127.0.0.1");
  assert.equal(dialTarget("192.0.2.10"), "192.0.2.10");
});

test("a wildcard compose bind is not dialed verbatim", () => {
  const compose = COMPOSE_MESH.replace("127.0.0.1", "0.0.0.0");
  assert.equal(resolveTopology({}, compose).host, "127.0.0.1");
});

test("an explicit host and base port measure without a compose file", () => {
  const topology = resolveTopology({ RELAY_HOST: "10.0.0.5", RELAY_BASE_PORT: "3101" }, null);
  assert.equal(topology.error, undefined);
  assert.equal(topology.host, "10.0.0.5");
  assert.equal(topology.basePort, 3101);
});

test("a tunnels-only deploy cannot be measured and says why", () => {
  const topology = resolveTopology({}, COMPOSE_TUNNELS);
  assert.ok(topology.error, "no relay publish line means no address to dial");
  assert.match(topology.error, /not host-published/);
  assert.match(topology.error, /not measuring/);
});

test("a missing compose file cannot be measured and says why", () => {
  const topology = resolveTopology({}, null);
  assert.ok(topology.error);
  assert.match(topology.error, /no docker-compose\.yml/);
});

test("a healthy configuration reports no errors", () => {
  assert.deepEqual(configErrors({}), []);
  assert.deepEqual(configErrors({ COUNT: "4", PROBE_MODELS: "a,b", INTERVAL_S: "60" }), []);
});

test("COUNT below one is refused before a pass starts", () => {
  assert.match(configErrors({ COUNT: "0" })[0], /COUNT must be an integer >= 1 \(got "0"\)/);
  assert.match(configErrors({ COUNT: "abc" })[0], /COUNT must be an integer >= 1/);
  assert.match(configErrors({ COUNT: "1.5" })[0], /COUNT must be an integer >= 1/);
});

test("an empty model list is refused before a pass starts", () => {
  assert.match(configErrors({ PROBE_MODELS: "" })[0], /PROBE_MODELS must list at least one model/);
  assert.match(configErrors({ PROBE_MODELS: " , " })[0], /PROBE_MODELS must list at least one model/);
});

test("a non-numeric INTERVAL_S is refused instead of hot-looping", () => {
  assert.match(configErrors({ INTERVAL_S: "abc" })[0], /INTERVAL_S must be a number >= 1 \(got "abc"\)/);
  assert.match(configErrors({ INTERVAL_S: "0" })[0], /INTERVAL_S must be a number >= 1/);
});

test("a non-positive PROBE_TIMEOUT_MS is refused", () => {
  assert.match(configErrors({ PROBE_TIMEOUT_MS: "0" })[0], /PROBE_TIMEOUT_MS must be a number > 0/);
  assert.match(configErrors({ PROBE_TIMEOUT_MS: "-1" })[0], /PROBE_TIMEOUT_MS must be a number > 0/);
});

test("a malformed RELAY_BASE_PORT is refused", () => {
  assert.match(configErrors({ RELAY_BASE_PORT: "abc" })[0], /RELAY_BASE_PORT must be a port number/);
});

test("the quota guard can never be 0", () => {
  assert.equal(quotaGuard(10, "0"), 1);
  assert.equal(quotaGuard(10, "-5"), 1);
  assert.equal(quotaGuard(10, "abc"), 9);
  assert.equal(quotaGuard(10, undefined), 9);
  assert.equal(quotaGuard(10, "3"), 3);
});
