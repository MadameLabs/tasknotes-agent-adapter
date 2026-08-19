import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = new URL("../src/cli.mjs", import.meta.url);

test("reports operational refusal as JSON without leaking configuration", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), "start"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: "missing_config", message: "--config is required" });
  assert.equal(result.stderr, "");
});
