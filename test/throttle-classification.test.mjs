import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `missing marker: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `missing end marker: ${endMarker}`);
  return src.slice(a, b);
}

const helpers = slice("export function isIndividualQuotaError", "function classifyAntigravityError");
const friendly = slice("function friendlyAntigravityError", "function formatRequestDiagnostics");

const factory = new Function(
  "LlmError",
  "THROTTLE_MAX_DELAY_MS",
  "THROTTLE_BASE_DELAY_MS",
  "THROTTLE_MAX_RETRIES",
  "redactSecrets",
  "jsonOrTextError",
  `${helpers.replaceAll("export function", "function")}
   ${friendly}
   return { isIndividualQuotaError, isBackendThrottleError, retryAfterDelayMs, sleepWithSignal, friendlyAntigravityError };`,
);

class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const api = factory(
  LlmError,
  20000,
  1500,
  4,
  (value) => String(value),
  (value) => (typeof value === "string" ? value : JSON.stringify(value)),
);

const backendThrottle = JSON.stringify({
  error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
});
const individualQuota = '{"error":{"code":429,"message":"Individual quota reached. Resets in 2h 13m.","status":"RESOURCE_EXHAUSTED"}}';

// 1. the real-world text we captured today is a backend throttle, not a personal quota
assert.equal(api.isIndividualQuotaError(backendThrottle), false);
assert.equal(api.isBackendThrottleError(429, backendThrottle), true);
assert.equal(api.isBackendThrottleError(429, ""), true);

// 2. the genuine per-user quota keeps its own branch
assert.equal(api.isIndividualQuotaError(individualQuota), true);
assert.equal(api.isBackendThrottleError(429, individualQuota), false);

// 3. non-429 statuses are never treated as a throttle
assert.equal(api.isBackendThrottleError(400, backendThrottle), false);
assert.equal(api.isBackendThrottleError(undefined, backendThrottle), false);

// 4. friendly wording must no longer claim the user's quota is gone
const throttleMsg = api.friendlyAntigravityError(429, backendThrottle);
assert.ok(!/^quota reached/i.test(throttleMsg), `throttle must not read as quota reached: ${throttleMsg}`);
assert.ok(!/quota/i.test(throttleMsg), `throttle wording must avoid the word quota: ${throttleMsg}`);
assert.match(throttleMsg, /throttl/i);
const quotaMsg = api.friendlyAntigravityError(429, individualQuota);
assert.match(quotaMsg, /^Quota reached\. Please wait 2h 13m\.$/);

// 5. retry-after parsing is capped by THROTTLE_MAX_DELAY_MS
const fakeResponse = (value) => ({ headers: { get: (name) => (name === "retry-after" ? value : null) } });
assert.equal(api.retryAfterDelayMs(fakeResponse("3")), 3000);
assert.equal(api.retryAfterDelayMs(fakeResponse("999")), 20000);
assert.equal(api.retryAfterDelayMs(fakeResponse(null)), undefined);

// 6. abortable sleep rejects instead of hanging
const ac = new AbortController();
const pending = api.sleepWithSignal(5000, ac.signal);
ac.abort();
await pending.then(
  () => { throw new Error("sleepWithSignal should reject on abort"); },
  (err) => assert.equal(err.code, "ABORTED"),
);

// 7. the retry loop wiring exists in the shipped file
assert.match(src, /isBackendThrottleError\(failureStatus, failureText\) && throttleRetries < THROTTLE_MAX_RETRIES/);
assert.match(src, /const failureCode = isBackendThrottleError\(failureStatus, failureText\)[\s\S]{0,80}"RATE_LIMIT"/);
assert.match(src, /pendingThrottleRetry = false;/);

console.log("ALL CHECKS PASSED");

