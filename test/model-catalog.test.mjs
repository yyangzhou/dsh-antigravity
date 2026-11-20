// Guards the static model registry against the live Cloud Code Assist catalog.
//
// The adapter resolves a public model id (what DSH shows) to a runtime id (what
// the backend serves) through ROUTING, and folds the per-tier runtime ids back
// into one public entry through parseCatalogModels(). Both halves break silently
// when upstream renames a family, so this test pins both against a real
// /v1internal:fetchAvailableModels snapshot.
//
// The adapter itself needs its DSH peer packages, which only exist inside the
// harness, so the source is loaded once with those imports stubbed out and the
// internals this file needs attached as extra exports.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const SOURCE_URL = new URL("../lib/index.js", import.meta.url);
const source = readFileSync(SOURCE_URL, "utf8");

const STUBS = `
const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";
class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = "LlmError";
  }
}
class LlmAdapter {}
const ToolCallId = (id) => id;
const ReasoningEffortId = (id) => id;
const attributionHeaders = () => ({});
const contentHasImage = () => false;
const isContextWindowExceededError = () => false;
const isQuotaExceededError = () => false;
const dshHomePath = (...parts) => ["/dsh-home-stub", ...parts].join("/");
const timeoutOf = () => undefined;
const idleWatchdog = (signal) => ({ signal, next: (value) => value, [Symbol.dispose]() {} });
class ProxyAgent {
  close() {}
}
const undiciFetch = () => {
  throw new Error("network access is not available in this test");
};
`;

const STUBBED_SPECIFIERS = [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-timeout",
  "undici",
];

function stubOutPeerImports(text) {
  let out = text;
  for (const specifier of STUBBED_SPECIFIERS) {
    const needle = `from "${specifier}";`;
    const at = out.indexOf(needle);
    assert.ok(at >= 0, `missing import of ${specifier}`);
    const start = out.lastIndexOf("import", at);
    assert.ok(start >= 0, `malformed import of ${specifier}`);
    out = `${out.slice(0, start)}${out.slice(at + needle.length)}`;
  }
  return `${STUBS}\n${out}`;
}

async function loadAdapterOutOfHarness() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-antigravity-test-"));
  const file = join(dir, "index.mjs");
  const extraExports = [
    "MODELS",
    "ROUTING",
    "RUNTIME_MAX_OUTPUT_TOKENS",
    "parseCatalogModels",
    "getMaxOutputTokens",
    "getAntigravityRequestModelId",
    "baseModelMatcher",
    "rowsForPublicModel",
  ];
  writeFileSync(
    file,
    `${stubOutPeerImports(source)}\nexport { ${extraExports.join(", ")} };\n`,
    "utf8",
  );
  return import(pathToFileURL(file).href);
}

const adapter = await loadAdapterOutOfHarness();
const {
  MODELS,
  ROUTING,
  RUNTIME_MAX_OUTPUT_TOKENS,
  parseCatalogModels,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  baseModelMatcher,
  rowsForPublicModel,
} = adapter;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/catalog-2026-11-20.json", import.meta.url), "utf8"),
);
const liveModels = fixture.models;
const liveIds = Object.keys(liveModels);

const modelById = (id) => MODELS.find((model) => model.id === id);
const routingTargets = (route) => [route.off, ...Object.values(route.routing), route.defaultRequestId];
/** Ids the account may actually request: no disabled placeholders, no internal workers. */
const usableLiveIds = liveIds.filter(
  (id) =>
    liveModels[id].isInternal !== true &&
    !id.startsWith("chat_") &&
    !id.startsWith("tab_") &&
    !/-disabled$/.test(id) &&
    !/-worker/.test(id),
);

// --- 1. Every public model is routable ---
for (const model of MODELS) {
  const route = ROUTING[model.id];
  assert.ok(route, `missing ROUTING entry for ${model.id}`);
  for (const target of routingTargets(route)) {
    assert.ok(target, `routing target for ${model.id} is empty`);
  }
}

// --- 2. Each live id is claimed by exactly one public model ---
// Two matchers matching the same runtime id means one public entry silently
// borrows another's quota (and the tier disappears from its real family).
const claims = new Map();
for (const id of usableLiveIds) {
  const name = liveModels[id].displayName ?? "";
  const owners = MODELS.filter((model) => {
    const matcher = baseModelMatcher(model.id);
    return matcher(id) || matcher(name);
  }).map((model) => model.id);
  assert.ok(owners.length <= 1, `${id} is claimed by ${owners.join(", ")}`);
  if (owners.length === 1) claims.set(id, owners[0]);
}
const currentPublicIds = new Set(claims.values());

// --- 3. A family that upstream still serves must only route to served tiers ---
// This is the failure this repo has hit before: a tier is renamed upstream, the
// router keeps pointing at the old id, and every request 404s.
for (const model of MODELS) {
  if (!currentPublicIds.has(model.id)) continue; // retired family, kept as a static fallback
  for (const target of routingTargets(ROUTING[model.id])) {
    assert.ok(
      liveIds.includes(target),
      `${model.id} routes to ${target}, which the live catalog no longer serves`,
    );
  }
}

// --- 4. The newest families are registered with the shape upstream advertises ---
const expectedNewModels = [
  {
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    tiers: ["gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh"],
  },
  {
    id: "gemini-pro-orchestrator-neon",
    name: "Orchestrator (Neon)",
    maxTokens: 65536,
    reasoningEfforts: [],
    tiers: ["gemini-pro-orchestrator-neon"],
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    maxTokens: 65535,
    reasoningEfforts: [],
    tiers: ["gemini-3.5-flash-lite"],
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    maxTokens: 65535,
    reasoningEfforts: [],
    tiers: ["gemini-3.1-flash-lite"],
  },
];
for (const expected of expectedNewModels) {
  const model = modelById(expected.id);
  assert.ok(model, `${expected.id} is missing from MODELS`);
  assert.equal(model.name, expected.name);
  assert.equal(model.maxTokens, expected.maxTokens);
  assert.deepEqual(model.reasoningEfforts, expected.reasoningEfforts);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.equal(model.contextWindow, 1048576);
  for (const tier of expected.tiers) {
    assert.equal(claims.get(tier), expected.id, `${tier} is not folded into ${expected.id}`);
    assert.ok(
      RUNTIME_MAX_OUTPUT_TOKENS[tier] !== undefined,
      `${tier} has no explicit RUNTIME_MAX_OUTPUT_TOKENS entry`,
    );
    assert.ok(
      RUNTIME_MAX_OUTPUT_TOKENS[tier] <= liveModels[tier].maxOutputTokens,
      `${tier} cap exceeds the backend cap`,
    );
  }
}
// The upstream relabel aliases the three gemini-2.5-flash ids to "Gemini 3.5
// Flash Lite"; they must stay under the legacy entry, not leak into the new one.
for (const alias of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking"]) {
  assert.equal(claims.get(alias), "gemini-2.5-flash");
}

// --- 5. Effort selection lands on a served tier ---
// `undefined` is the "no thinking" path (the adapter resolves a model's default
// effort before calling this), so it maps to the family's `off` tier.
assert.equal(getAntigravityRequestModelId("gemini-4-neon", undefined), "gemini-4-neon-low");
assert.equal(getAntigravityRequestModelId("gemini-4-neon", "off"), "gemini-4-neon-low");
assert.equal(getAntigravityRequestModelId("gemini-4-neon", "minimal"), "gemini-4-neon-low");
assert.equal(getAntigravityRequestModelId("gemini-4-neon", "medium"), "gemini-4-neon-medium");
assert.equal(getAntigravityRequestModelId("gemini-4-neon", "high"), "gemini-4-neon-high");
assert.equal(getAntigravityRequestModelId("gemini-4-neon", "xhigh"), "gemini-4-neon-xhigh");
assert.equal(getAntigravityRequestModelId("gemini-4-argon", "off"), "gemini-4-argon-low");
for (const effort of [undefined, "off", "minimal", "low", "medium", "high", "xhigh"]) {
  assert.equal(
    getAntigravityRequestModelId("gemini-pro-orchestrator-neon", effort),
    "gemini-pro-orchestrator-neon",
  );
  assert.equal(getAntigravityRequestModelId("gemini-3.5-flash-lite", effort), "gemini-3.5-flash-lite");
  assert.equal(getAntigravityRequestModelId("gemini-3.1-flash-lite", effort), "gemini-3.1-flash-lite");
}
assert.equal(getMaxOutputTokens("gemini-4-neon", "gemini-4-neon-xhigh"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.5-flash-lite", "gemini-3.5-flash-lite"), 65535);

// --- 6. The consolidated catalog carries the new entries exactly once ---
const catalog = parseCatalogModels(fixture);
const byId = new Map();
for (const entry of catalog) {
  assert.ok(!byId.has(entry.id), `duplicate catalog entry ${entry.id}`);
  byId.set(entry.id, entry);
}
for (const expected of expectedNewModels) {
  const entry = byId.get(expected.id);
  assert.ok(entry, `${expected.id} is missing from the consolidated catalog`);
  assert.equal(entry.name, expected.name);
  assert.equal(entry.available, true);
  for (const tier of expected.tiers) {
    // Single-tier families (orchestrator, lite) use the public id as their
    // runtime id, so only the extra tiers must be folded away.
    if (tier !== expected.id) {
      assert.ok(!byId.has(tier), `${tier} should be folded into ${expected.id}, not listed on its own`);
    }
  }
}
const neon = byId.get("gemini-4-neon");
assert.equal(neon.remainingFraction, liveModels["gemini-4-neon-high"].quotaInfo.remainingFraction);
assert.equal(neon.resetTime, liveModels["gemini-4-neon-high"].quotaInfo.resetTime);
assert.equal(neon.modelProvider, "MODEL_PROVIDER_GOOGLE");
assert.equal(catalog.filter((entry) => entry.name === "Gemini 3.5 Flash Lite").length, 1);
assert.equal(byId.get("gemini-pro-orchestrator").remainingFraction, 0.64085215);
assert.equal(byId.get("gemini-pro-orchestrator-neon").remainingFraction, 1);

// --- 7. Quota rows are attributed to one public model each ---
// Same matcher, same partition rule: quota rows must not be shared, or the
// settings card shows one family's remaining quota under another's name.
const quota = {
  models: liveIds.map((id) => ({
    modelId: id,
    displayName: liveModels[id].displayName,
    remainingFraction: liveModels[id].quotaInfo?.remainingFraction,
    resetTime: liveModels[id].quotaInfo?.resetTime,
  })),
};
const rowOwners = new Map();
for (const model of MODELS) {
  for (const row of rowsForPublicModel(model, quota)) {
    const owners = rowOwners.get(row.id) ?? [];
    owners.push(model.id);
    rowOwners.set(row.id, owners);
  }
}
for (const [rowId, owners] of rowOwners) {
  assert.equal(owners.length, 1, `quota row ${rowId} is claimed by ${owners.join(", ")}`);
}
assert.deepEqual(
  rowsForPublicModel(modelById("gemini-4-neon"), quota).map((row) => row.id).sort(),
  ["gemini-4-neon-high", "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-xhigh"],
);
assert.deepEqual(
  rowsForPublicModel(modelById("gemini-pro-orchestrator"), quota).map((row) => row.id),
  ["gemini-pro-orchestrator-g1-pro"],
);
assert.deepEqual(
  rowsForPublicModel(modelById("gemini-pro-orchestrator-neon"), quota).map((row) => row.id),
  ["gemini-pro-orchestrator-neon"],
);
assert.deepEqual(
  rowsForPublicModel(modelById("gemini-3.5-flash"), quota).map((row) => row.id),
  [],
);
assert.deepEqual(
  rowsForPublicModel(modelById("gemini-3.5-flash-lite"), quota).map((row) => row.id),
  ["gemini-3.5-flash-lite"],
);

console.log("ALL CHECKS PASSED");
