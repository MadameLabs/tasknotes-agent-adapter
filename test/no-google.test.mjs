import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function importsFrom(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /\b(gtasks|googleapis|oauth|webhook|poller)\b/i);
  for (const match of source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
    await importsFrom(resolve(dirname(file), match[1]), seen);
  }
  return seen;
}

test("the adapter entrypoint has no Google Tasks dependency", async () => {
  const files = await importsFrom(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)));
  assert.ok(files.size > 0);
});
