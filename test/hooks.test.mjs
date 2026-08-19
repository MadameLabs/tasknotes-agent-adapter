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

test("rejects a missing or blank session id", () => {
  assert.throws(() => parseHookPayload("codex", "Stop", {}), /missing_session_id/);
  assert.throws(() => parseHookPayload("claude", "Stop", { session_id: " " }), /missing_session_id/);
});
