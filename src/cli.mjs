#!/usr/bin/env node
import { loadConfig } from "./config.mjs";

const configIndex = process.argv.indexOf("--config");
if (configIndex === -1 || !process.argv[configIndex + 1]) {
  console.error("missing_config");
  process.exitCode = 2;
} else {
  await loadConfig(process.argv[configIndex + 1]);
  console.log(JSON.stringify({ ok: true }));
}
