import assert from "node:assert/strict";
import test from "node:test";

import { parseHookPayload } from "../src/hooks.mjs";

test("normalizes Claude payloads", () => {
  assert.deepEqual(parseHookPayload("claude", "SessionStart", { session_id: "abc", cwd: "C:/x" }), {
    sessionKey: "claude:abc",
    sessionId: "abc",
    event: "SessionStart",
    cwd: "C:/x",
  });
});

test("normalizes Codex payloads", () => {
  assert.equal(parseHookPayload("codex", "Stop", { session_id: "abc" }).sessionKey, "codex:abc");
});

test("normalizes opencode payloads", () => {
  const hook = parseHookPayload("opencode", "SessionStart", { session_id: "abc", cwd: "C:/madamelabs-code" });
  assert.equal(hook.sessionKey, "opencode:abc");
  assert.equal(hook.event, "SessionStart");
  assert.equal(hook.cwd, "C:/madamelabs-code");
});

test("normalizes oh-my-pi payloads and still rejects unknown agents", () => {
  assert.equal(parseHookPayload("omp", "SessionStart", { session_id: "abc" }).sessionKey, "omp:abc");
  assert.throws(() => parseHookPayload("inventado", "SessionStart", { session_id: "abc" }), /invalid_agent/);
});

test("rejects a missing or blank session id", () => {
  assert.throws(() => parseHookPayload("codex", "Stop", {}), /missing_session_id/);
  assert.throws(() => parseHookPayload("claude", "Stop", { session_id: " " }), /missing_session_id/);
});
