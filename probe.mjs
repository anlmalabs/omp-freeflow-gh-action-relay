#!/usr/bin/env node
/**
 * probe.mjs — throttle detector for the direct-egress relay pool.
 *
 * Every relay in this pool egresses from ONE address: the host's, or on a
 * GitHub Actions pool the runner's (see server.mjs — the relay app dials the
 * upstream itself). There is nothing to rotate to: a container restart
 * returns the same IP, so a 429 can no longer be cleared by restarting
 * anything. This script therefore only DETECTS and REPORTS throttling. It
 * never touches a container — no docker calls, no restarts, no tunnel or
 * relay churn.
 *
 * Throttling is PER MODEL per IP: with one shared IP a per-IP upstream limit
 * throttles the whole pool at once, and a pool-wide wave looks identical to
 * upstream model quota. To tell those apart, every relay is probed with a
 * real streaming inference request for EACH model in PROBE_MODELS (chat +
 * responses paths, official-client fingerprint headers):
 *
 *   - a model throttled on a MAJORITY of relays is upstream model quota
 *     (GLOBAL_QUOTA_GUARD) — reported as such, because no per-relay
 *     distinction exists to act on;
 *   - a model throttled on a FEW relays is reported per relay and model,
 *     which on one shared IP usually means that request raced an upstream
 *     window rather than hit a real per-IP limit.
 *
 * Exit code:
 *   0 — every probed relay/model pair answered HTTP 200 (no 429, no
 *       unreachable relay, no unexpected status, no server_error inside a
 *       200 stream);
 *   1 — at least one relay/model pair failed: a 429 (throttled, whether or
 *       not the quota guard labelled that model "upstream quota"), an
 *       unreachable relay, an unexpected status, or a server_error inside a
 *       200 stream;
 *   2 — the pass could not measure the pool at all: an invalid
 *       configuration, or a topology the prober has no address for (a
 *       tunnels-only deploy, where the relay router is not host-published).
 * The quota guard is a REPORTING concept only — it labels a 429 wave as
 * upstream quota on the shared egress — and never changes the exit code, so
 * a throttled pool is never reported as a clean pass. Either way a completed
 * pass never crashes: an unreachable relay is data, and it is data that
 * fails the pass, because an alert must mean a real measurement rather than
 * a green light over an unprobed pool.
 *
 * Usage:
 *   node probe.mjs --once                 # single pass
 *   node probe.mjs --loop                 # pass every INTERVAL_S seconds
 *   INTERVAL_S=600 node probe.mjs --loop
 *
 * Environment (RELAY_HOST / RELAY_BASE_PORT are read from the generated
 * docker-compose.yml when unset — see resolveTopology):
 *   RELAY_HOST          relay app address as seen from the probe host
 *                       (default: the bind parsed out of docker-compose.yml;
 *                       a wildcard bind — `*` or 0.0.0.0 — is dialed as
 *                       127.0.0.1, any other bind is used as-is)
 *   RELAY_BASE_PORT     HOST-published port of relay 1; relay N is dialed at
 *                       RELAY_BASE_PORT + (N - 1) (default derived from the
 *                       compose publish line, i.e. relay 1 on 3101 as the
 *                       generator writes it)
 *   BASE_PORT           NOT read by the prober. It is the relay app's
 *                       IN-CONTAINER base, baked into docker-compose.yml by
 *                       the generator: relay N listens on BASE_PORT + N
 *                       inside the container (3001-3010 by default). An
 *                       install that still exports BASE_PORT=3000 — the
 *                       retired .env.example shipped it uncommented — must
 *                       not make the prober dial 3000..3009 while the host
 *                       publishes 3101..3110, so the variable is inert here.
 *                       To probe the app's own listeners from inside the
 *                       compose network, set RELAY_BASE_PORT=3001.
 *   COUNT               number of relays      (default 10)
 *   PROBE_TARGET        upstream the probes go through (default
 *                       https://api.kilo.ai — the lane clients actually
 *                       use; OpenCode's Zen free tier has refused every
 *                       non-OpenCode client with 403 FreeTierError since
 *                       2026-10-14, fingerprints included)
 *   PROBE_CHAT_PATH     chat wire path under PROBE_TARGET (default
 *                       /api/gateway/chat/completions)
 *   PROBE_RESPONSES_PATH  responses wire path under PROBE_TARGET (default
 *                       /api/gateway/responses)
 *   PROBE_MODELS        comma-separated models to probe (default
 *                       nvidia/nemotron-3.5-lightning:free,
 *                       cohere/north-mini-code:free,
 *                       dots-studio/dots-3-note-preview:free — three
 *                       families so quota waves stay distinguishable)
 *   PROBE_MODEL         legacy single-model override (used only when
 *                       PROBE_MODELS is unset)
 *   RESPONSES_MODELS    comma-separated models probed via
 *                       PROBE_RESPONSES_PATH (default
 *                       dots-studio/dots-3-note-preview:free; everything
 *                       else probes via PROBE_CHAT_PATH)
 *   GLOBAL_QUOTA_GUARD  relays-429ed threshold at which a model is REPORTED
 *                       as upstream quota rather than per-relay throttling
 *                       (default max(8, COUNT - 1), capped at COUNT, never
 *                       below 1). Reporting only — it never changes the
 *                       exit code.
 *   SPEED_MODEL         model whose latency is ranked for observability
 *                       (default nvidia/nemotron-3.5-lightning:free; must
 *                       be in PROBE_MODELS to have timings)
 *   PROBE_TIMEOUT_MS    per-probe request timeout     (default 30000)
 *   INTERVAL_S          seconds between loop passes   (default 300)
 *   KEEP_COLD_LOG       append the log to this file   (default stdout only)
 *   KEEP_COLD_LOG_MAX_BYTES  rotate above this size    (default 2 MiB)
 *   KEEP_COLD_LOG_KEEP_BYTES keep this much on rotate   (default 200 KiB)
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────
// 0 = every probed relay/model pair answered 200; 1 = at least one pair
// failed (429, unreachable relay, unexpected status, server_error inside a
// 200 stream); 2 = the pass could not measure the pool at all (invalid
// configuration, or a topology the prober has no address for).
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CONFIG = 2;

/** Comma-separated model list -> trimmed, non-empty entries. */
function splitModels(raw) {
 return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** A TCP port: an integer in 1..65535. */
function isPortNumber(value) {
 const n = Number(value);
 return Number.isInteger(n) && n >= 1 && n <= 65535;
}

const DEFAULT_PROBE_MODELS = "nvidia/nemotron-3.5-lightning:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free";
const COUNT = Number(process.env.COUNT ?? 10);
const PROBE_TARGET = process.env.PROBE_TARGET ?? "https://api.kilo.ai";
const PROBE_CHAT_PATH = process.env.PROBE_CHAT_PATH ?? "/api/gateway/chat/completions";
const PROBE_RESPONSES_PATH = process.env.PROBE_RESPONSES_PATH ?? "/api/gateway/responses";
const PROBE_MODELS = splitModels(process.env.PROBE_MODELS ?? process.env.PROBE_MODEL ?? DEFAULT_PROBE_MODELS);
const RESPONSES_MODELS = new Set(
 splitModels(process.env.RESPONSES_MODELS ?? "dots-studio/dots-3-note-preview:free"),
);
/**
 * The quota guard: how many relays 429ing make a model count as upstream
 * quota on the shared egress. Reporting only — it never changes the exit
 * code — and clamped to at least 1, because a guard of 0 would make EVERY
 * 429ed model look quota-capped.
 */
export function quotaGuard(count, raw) {
 const fallback = Math.min(Math.max(8, count - 1), count);
 const n = Number(raw ?? fallback);
 if (!Number.isFinite(n)) return fallback;
 return Math.min(Math.max(1, Math.floor(n)), Math.max(1, count));
}

const GLOBAL_QUOTA_GUARD = quotaGuard(COUNT, process.env.GLOBAL_QUOTA_GUARD);
const SPEED_MODEL = process.env.SPEED_MODEL ?? "nvidia/nemotron-3.5-lightning:free";
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 30_000);
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 300);
const LOOP = process.argv.includes("--loop");

/**
 * The configuration mistakes that would silently produce a green pass over
 * an unprobed pool (COUNT=0, an empty PROBE_MODELS) or a hot loop that fires
 * real inference requests at the upstream (a non-numeric INTERVAL_S becomes
 * NaN, and setTimeout(NaN) fires immediately — measured: 1684 passes in
 * 3 seconds). Each violation is named once, with the value that caused it.
 */
export function configErrors(env = {}) {
 const errors = [];
 const count = Number(env.COUNT ?? 10);
 if (!Number.isInteger(count) || count < 1) {
  errors.push(`COUNT must be an integer >= 1 (got ${JSON.stringify(env.COUNT ?? "10")})`);
 }
 const models = splitModels(env.PROBE_MODELS ?? env.PROBE_MODEL ?? DEFAULT_PROBE_MODELS);
 if (!models.length) {
  errors.push(`PROBE_MODELS must list at least one model (got ${JSON.stringify(env.PROBE_MODELS ?? env.PROBE_MODEL ?? "")})`);
 }
 const timeout = Number(env.PROBE_TIMEOUT_MS ?? 30_000);
 if (!Number.isFinite(timeout) || timeout <= 0) {
  errors.push(`PROBE_TIMEOUT_MS must be a number > 0 (got ${JSON.stringify(env.PROBE_TIMEOUT_MS ?? "30000")})`);
 }
 const interval = Number(env.INTERVAL_S ?? 300);
 if (!Number.isFinite(interval) || interval < 1) {
  errors.push(`INTERVAL_S must be a number >= 1 (got ${JSON.stringify(env.INTERVAL_S ?? "300")})`);
 }
 const basePort = (env.RELAY_BASE_PORT ?? "").trim();
 if (basePort !== "" && !isPortNumber(basePort)) {
  errors.push(`RELAY_BASE_PORT must be a port number (got ${JSON.stringify(env.RELAY_BASE_PORT)})`);
 }
 return errors;
}

/**
 * Where the probes dial from, and to which port.
 *
 * RELAY_HOST is the address the relay router is published on and
 * RELAY_BASE_PORT the HOST-published port of relay 1; relay N is dialed at
 * RELAY_BASE_PORT + (N - 1). Both default to what the generated
 * docker-compose.yml actually publishes, so a mesh install published on a
 * Tailscale IP is probed there rather than at loopback.
 *
 * BASE_PORT is deliberately NOT read: it is the relay app's IN-CONTAINER
 * base — the generator bakes it into the compose file, and relay N listens
 * on BASE_PORT + N inside the container (3001-3010 by default). An install
 * that still exports BASE_PORT=3000 (the retired .env.example shipped it
 * uncommented, and the old systemd unit shipped it too) would otherwise make
 * the prober dial 3000..3009 while the host publishes 3101..3110 — the whole
 * pool reading as unreachable, forever. From inside the compose network the
 * equivalent override is RELAY_BASE_PORT=3001.
 */
let RELAY_HOST = "";
let RELAY_BASE_PORT = 0;

/** The address the probes dial: a wildcard bind means loopback, not 0.0.0.0. */
export function dialTarget(bind) {
 const b = (bind ?? "").trim();
 // `*` and 0.0.0.0 are "every interface" binds. Dialing 0.0.0.0 is a no-op on
 // Linux (it means localhost there) and looks like a broken host in a log, so
 // both map to loopback. Any other bind — a Tailscale IP, say — is a real
 // address and is used as-is.
 if (!b || b === "*" || b === "0.0.0.0") return "127.0.0.1";
 return b;
}

/**
 * Isolate the `relay` service's `ports:` block: one published line list.
 *
 * The `relay` service specifically: a --with-tunnels publish adds tunnel
 * services with no ports, but any file could carry another service with a
 * published range, and the relay fleet is the one this probe exists to
 * measure. A file with no relay publish line yields null — there is nothing
 * to dial, which is a topology the prober cannot measure, not a pool that is
 * down.
 */
export function parseRelayPorts(compose) {
 const relay = compose.match(/^ {2}relay:(?:\n(?: {4,}\S.*))+/m);
 if (!relay) return null;
 const ports = relay[0].match(/^ {2,4}ports:\n((?: {4,8}-.*\n?)+)/m);
 if (!ports) return null;
 // `      - "127.0.0.1:3101-3110:3001-3010"` — bind, host range, container range.
 const entry = ports[1].match(/- *"?\[?([^\]":\s]+)\]?(?::(\d+(?:-\d+)?)(?::(\d+(?:-\d+)?))?)"?/);
 if (!entry) return null;
 const [, bind, hostRange, contRange] = entry;
 const hostLo = Number(hostRange.split("-")[0]);
 const hostHi = Number(hostRange.split("-")[1] ?? hostLo);
 const contLo = Number(contRange?.split("-")[0] ?? hostLo);
 const contHi = Number(contRange?.split("-")[1] ?? contLo);
 // The published range must describe one host port per relay, in lockstep
 // with the container range, so relay N maps to RELAY_BASE_PORT + (N - 1)
 // only when the two spans match.
 const hostSpan = hostHi - hostLo + 1;
 const contSpan = contHi - contLo + 1;
 if (hostSpan !== contSpan || contSpan < 1) return null;
 // hostBase is the HOST-published port of relay 1 (3101 for the generator's
 // default publish line).
 return { bind: bind.trim(), hostBase: hostLo, count: hostSpan };
}

/**
 * Resolve the dial target, or explain why the pool cannot be addressed.
 *
 * Three cases, in order:
 *   - the operator named both ends (RELAY_HOST and RELAY_BASE_PORT): the
 *     pool is addressable by fiat, no compose file needed;
 *   - the compose file publishes the relay router: the bind and the host
 *     port range are read out of it — a pool that is then down legitimately
 *     reports unreachable;
 *   - neither: there is no address for the relays (tunnels-only deploy,
 *     GitHub Actions runner pool, bare checkout), so the pass cannot measure
 *     anything. It says so ONCE and exits 2, instead of reporting every
 *     relay unreachable against a perfectly healthy pool.
 */
export function resolveTopology(env = {}, compose = null, composePath = "docker-compose.yml") {
 const host = (env.RELAY_HOST ?? "").trim();
 const baseRaw = (env.RELAY_BASE_PORT ?? "").trim();
 const base = baseRaw === "" ? null : Number(baseRaw);
 const explicitBase = base !== null && isPortNumber(base);
 if (host && explicitBase) {
  return { host: dialTarget(host), basePort: base };
 }
 const published = compose ? parseRelayPorts(compose) : null;
 if (published) {
  return {
   host: host ? dialTarget(host) : dialTarget(published.bind),
   basePort: explicitBase ? base : published.hostBase,
  };
 }
 const cause = compose === null
  ? `no ${composePath} in the working directory`
  : `relay router is not host-published in ${composePath} (tunnels-only deploy, or a published range that does not match the container range)`;
 return { error: `${cause} — the prober cannot address the relays; not measuring` };
}

/** The generated compose file, or null when there is none to read. */
function readCompose() {
 try {
  return fs.readFileSync("docker-compose.yml", "utf8");
 } catch {
  return null; // No compose file (tunnels-only, runner, bare checkout).
 }
}

/** Port relay `index` is probed on (relay 1 is the first relay). */
function relayPort(index) {
 return RELAY_BASE_PORT + index - 1;
}

// ── Upstream fingerprint ────────────────────────────────────────────
// Historically OpenCode's free tier rejected requests that did not look like
// the official client, so the probe carried the same headers and tool
// declarations the proxy sends — a 403 would have hidden the 429 we are
// looking for. Since 2026-10-14 that tier refuses every non-OpenCode client
// regardless of shape (403 FreeTierError), so the defaults target the Kilo
// lane, where these headers are ignored but harmless; the fingerprint is
// kept for pools still pointed at opencode.ai via PROBE_TARGET.
const OPENCODE_CLIENT = "cli";
const OPENCODE_PROJECT = createHash("sha1")
 .update("git-remote:github.com/anomalyco/opencode")
 .digest("hex");
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `ses_` + 12 hex + 14 alphanumeric, the shape the upstream gate validates. */
function sessionId() {
 const hex = randomBytes(6).toString("hex");
 let rest = "";
 const bytes = randomBytes(14);
 for (let i = 0; i < 14; i++) rest += ID_CHARS[bytes[i] % ID_CHARS.length];
 return `ses_${hex}${rest}`;
}

const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"];
// Chat Completions placeholder shape: { type, function: { name, ... } }.
const PLACEHOLDER_TOOLS = FINGERPRINT_TOOLS.map((name) => ({
 type: "function",
 function: { name, description: `${name} (probe)`, parameters: { type: "object", properties: {} } },
}));
// Responses placeholder shape: flat { type, name, ... }.
const RESPONSE_PLACEHOLDER_TOOLS = FINGERPRINT_TOOLS.map((name) => ({
 type: "function",
 name,
 description: `${name} (probe)`,
 parameters: { type: "object", properties: {} },
}));

/** Build the wire-path + body for a probed model (chat vs responses). */
function buildProbe(model) {
 if (RESPONSES_MODELS.has(model)) {
  return {
   relayPath: PROBE_RESPONSES_PATH,
   body: JSON.stringify({
    model,
    input: "ping",
    stream: true,
    tools: RESPONSE_PLACEHOLDER_TOOLS,
   }),
  };
 }
 return {
  relayPath: PROBE_CHAT_PATH,
  body: JSON.stringify({
   model,
   stream: true,
   max_tokens: 4,
   messages: [{ role: "user", content: "ping" }],
   tools: PLACEHOLDER_TOOLS,
  }),
 };
}

function probeHeaders(relayPath) {
 return {
  "content-type": "application/json",
  "user-agent": "opencode/1.18.31",
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": OPENCODE_PROJECT,
  "x-opencode-session": sessionId(),
  "x-opencode-request": `msg_${randomBytes(6).toString("hex")}${randomBytes(14).toString("base64url").slice(0, 14)}`,
  // Route through the in-container relay app; the public tunnel is bypassed
  // on purpose so a pass never depends on tunnel state.
  "x-relay-target": PROBE_TARGET,
  "x-relay-path": relayPath,
  accept: "text/event-stream",
 };
}

// ── Logging ─────────────────────────────────────────────────────────
const LOG_PATH = process.env.KEEP_COLD_LOG ?? "";
const LOG_MAX_BYTES = Number(process.env.KEEP_COLD_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
const LOG_KEEP_BYTES = Number(process.env.KEEP_COLD_LOG_KEEP_BYTES ?? 200 * 1024);

/** Trim the log in place once it passes the cap, keeping the newest slice. */
function rotateLogIfNeeded() {
 try {
  if (fs.statSync(LOG_PATH).size <= LOG_MAX_BYTES) return;
  const buf = fs.readFileSync(LOG_PATH);
  fs.writeFileSync(LOG_PATH, buf.subarray(Math.max(0, buf.length - LOG_KEEP_BYTES)));
 } catch {
  // Missing log file — nothing to rotate.
 }
}

/** Always to stdout (journald captures it); optionally also to a file. */
function log(msg) {
 const line = `[${new Date().toISOString()}] ${msg}\n`;
 process.stdout.write(line);
 if (!LOG_PATH) return;
 try {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_PATH, line);
 } catch {
  // Logging must never break a pass.
 }
}

// ── Probing ─────────────────────────────────────────────────────────
/**
 * The relay's own health endpoint (no x-relay-target) answers with
 * `Relay #N OK (direct)` plus a cloudflare trace body carrying `ip=`. With
 * direct egress that `ip` IS the pool's single egress address, so it is
 * logged once per pass — it is the number a 429 actually applies to. The
 * relay container has no curl/wget, so this runs as a plain node fetch from
 * the probe host against the host-published port.
 * Returns the address, or null when the relay is unreachable.
 */
async function egressIp(index = 1) {
 try {
  const res = await fetch(`http://${RELAY_HOST}:${relayPort(index)}/`, {
   signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const text = await res.text();
  return (text.match(/^ip=(.+)$/m)?.[1] ?? "").trim() || null;
 } catch {
  return null;
 }
}

/** Matches both server_error shapes: transport JSON and 200-SSE envelope. */
const SERVER_ERROR_RE = /server_error|response\.failed|failed to generate/i;

/** Transport shape: non-200/non-429 JSON carrying the upstream failure. */
function isServerError(status, detail) {
 if (status === 200 || status === 429 || status === 0) return false;
 return SERVER_ERROR_RE.test(detail ?? "");
}

/**
 * Read at most the first 2 SSE chunks (~4KB cap) of a 200 body, then cancel.
 * Envelope-shape server_error hides inside 200 streams, which a probe that
 * never reads the body counts as clean.
 */
async function readEnvelopeHead(res) {
 const reader = res.body?.getReader?.();
 if (!reader) {
  await res.body?.cancel().catch(() => { });
  return "";
 }
 const dec = new TextDecoder();
 let head = "";
 try {
  for (let n = 0; n < 2; n++) {
   const { done, value } = await reader.read();
   if (done) break;
   head += dec.decode(value, { stream: true });
   if (head.length >= 4096) break;
  }
 } finally {
  await reader.cancel().catch(() => { });
 }
 return head.slice(0, 4096);
}

async function probe(index, model) {
 const url = `http://${RELAY_HOST}:${relayPort(index)}`;
 const { relayPath, body } = buildProbe(model);
 const t0 = Date.now();
 try {
  const res = await fetch(url, {
   method: "POST",
   headers: probeHeaders(relayPath),
   body,
   signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status === 200) {
   const head = await readEnvelopeHead(res).catch(() => "");
   const ms = Date.now() - t0;
   if (SERVER_ERROR_RE.test(head)) {
    const evt = /response\.failed/i.test(head) ? "response.failed" : /failed to generate/i.test(head) ? "failed to generate" : "server_error";
    return { index, model, status: 200, serverError: true, detail: `envelope SSE ${evt}: ${head.replace(/\s+/g, " ").slice(0, 120)}`, ms };
   }
   return { index, model, status: 200, serverError: false, detail: "", ms };
  }
  const text = await res.text().catch(() => "");
  const detail = text.replace(/\s+/g, " ").slice(0, 160);
  return { index, model, status: res.status, serverError: isServerError(res.status, detail), detail, ms: Date.now() - t0 };
 } catch (e) {
  return { index, model, status: 0, serverError: false, detail: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0 };
 }
}

/** Probe a set of models on one relay (serial — one shared egress). */
async function probeRelay(index, models = PROBE_MODELS) {
 const out = [];
 for (const model of models) out.push(await probe(index, model));
 return out;
}

// ── One pass ────────────────────────────────────────────────────────
async function pass() {
 log(`probing ${COUNT} relay(s) x ${PROBE_MODELS.length} model(s) via ${RELAY_HOST}:${relayPort(1)}..${relayPort(COUNT)} (direct egress — detection only, nothing is restarted)`);
 const sharedIp = await egressIp(1);
 log(sharedIp
  ? `egress ${sharedIp} (relay #1 health check — the one IP the whole pool shares)`
  : `egress unknown (relay #1 health check unreachable at ${RELAY_HOST}:${relayPort(1)})`);
 const perRelay = await Promise.all(
  Array.from({ length: COUNT }, (_, k) => probeRelay(k + 1)),
 );
 const results = perRelay.flat();

 // Latency ranking on the speed model (observability only — no action is
 // taken on it). One shared egress means no relay can be faster upstream
 // than another, so spread here is upstream variance, not pool health.
 const speedRows = results
  .filter((r) => r.model === SPEED_MODEL && r.status === 200 && !r.serverError)
  .sort((a, b) => a.ms - b.ms);
 if (speedRows.length) {
  log(`speed ${SPEED_MODEL}: ` + speedRows.map((r) => `#${r.index} ${r.ms}ms`).join(" "));
 }

 // Global-quota guard: a model 429ing on a majority of relays is upstream
 // model quota against the shared IP — one limit, one address, every relay
 // at once. Reported distinctly so a pool-wide wave is not misread as a
 // pool of independently broken relays. The guard is REPORTING only: it
 // labels the wave, it never decides the exit code.
 const throttledCount = new Map(); // model -> relays answering 429
 for (const r of results) {
  if (r.status === 429) throttledCount.set(r.model, (throttledCount.get(r.model) ?? 0) + 1);
 }
 const quotaCapped = new Set(
  [...throttledCount.entries()].filter(([, n]) => n >= GLOBAL_QUOTA_GUARD).map(([m]) => m),
 );
 for (const m of quotaCapped) {
  log(`${m} throttled on ${throttledCount.get(m)}/${COUNT} relays — upstream quota on the shared egress, not per-relay throttling`);
 }

 const throttled = []; // relay -> models at 429
 const troubled = [];  // unreachable / unexpected status / server_error
 for (const r of results) {
  if (r.status === 429) {
   log(`#${r.index} ${r.model} throttled (429)${quotaCapped.has(r.model) ? " [quota-capped]" : ""}`);
   throttled.push(r);
  } else if (r.serverError) {
   log(`#${r.index} ${r.model} server_error (HTTP ${r.status}) — ${r.detail}`);
   troubled.push(r);
  } else if (r.status !== 200) {
   const why = r.status === 0 ? "unreachable" : `unexpected HTTP ${r.status}`;
   log(`#${r.index} ${r.model} ${why} — ${r.detail}`);
   troubled.push(r);
  }
 }

 const hot = new Map(); // index -> throttled models
 for (const r of throttled) {
  if (!hot.has(r.index)) hot.set(r.index, []);
  hot.get(r.index).push(r.model);
 }
 const badIndexes = new Set([...hot.keys(), ...troubled.map((r) => r.index)]);
 log(`clean ${COUNT - badIndexes.size}/${COUNT} relay(s)`
  + (hot.size ? ` | throttled: ${[...hot.entries()].map(([i, ms]) => `#${i}(${ms.join(",")})`).join(" ")}` : "")
  + (troubled.some((r) => r.status === 0) ? ` | unreachable: ${[...new Set(troubled.filter((r) => r.status === 0).map((r) => r.index))].map((i) => `#${i}`).join(" ")}` : ""));

 // Direct egress leaves no remediation: the only fix for a 429 is a
 // different egress address (redeploy, or a new runner for the CI pool).
 // So the pass reports and exits — nothing is restarted, and no container
 // name is ever touched.
 // The quota guard only LABELS a 429 wave as upstream quota; it never
 // decides the exit code. Every 429 counts against the pass, because a
 // pool-wide wave reported next to "clean 0/N relay(s)" and a green exit
 // code is a monitoring timer reporting success over a throttled pool.
 return throttled.length === 0 && troubled.length === 0;
}

// ── Entry point ─────────────────────────────────────────────────────
/**
 * True when this file is the program being run, not a module imported by a
 * test — the pure helpers above are exported for test/probe-config.test.mjs,
 * and importing them must not start a pass.
 */
function isMainModule() {
 const entry = process.argv[1];
 if (!entry) return false;
 if (pathToFileURL(entry).href === import.meta.url) return true;
 try {
  // A symlinked checkout: import.meta.url is the resolved real path.
  return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
 } catch {
  return false;
 }
}

/**
 * One prober run: validate the configuration, resolve the pool's address,
 * then measure it (once) or keep measuring it (loop).
 */
async function run() {
 const errors = configErrors(process.env);
 if (errors.length) {
  log(`invalid configuration — ${errors.join("; ")}`);
  process.exit(EXIT_CONFIG);
 }
 const topology = resolveTopology(process.env, readCompose());
 if (topology.error) {
  log(topology.error);
  process.exit(EXIT_CONFIG);
 }
 RELAY_HOST = topology.host;
 RELAY_BASE_PORT = topology.basePort;
 if (LOOP) {
  log(`loop mode: pass every ${INTERVAL_S}s (Ctrl-C to stop)`);
  for (; ;) {
   try {
    await pass();
   } catch (e) {
    log(`pass failed: ${String(e?.message ?? e).slice(0, 200)}`);
   }
   await new Promise((r) => setTimeout(r, INTERVAL_S * 1_000));
  }
 } else {
  const clean = await pass();
  process.exit(clean ? EXIT_OK : EXIT_FAILED);
 }
}

if (isMainModule()) {
 await run();
}
