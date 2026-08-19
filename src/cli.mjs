#!/usr/bin/env node
import { loadConfig } from "./config.mjs";

const [command] = process.argv.slice(2);
const configIndex = process.argv.indexOf("--config");
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (configIndex === -1 || !process.argv[configIndex + 1]) {
  output({ ok: false, error: "missing_config", message: "--config is required" });
  process.exitCode = 2;
} else {
  try {
    const config = await loadConfig(process.argv[configIndex + 1]);
    if (!["hook-start", "hook-end", "open", "create", "start", "stop", "diagnose", "recover", "reset"].includes(command)) {
      output({ ok: false, error: "unknown_command", message: "unsupported command" });
      process.exitCode = 2;
    } else {
      output({ ok: true, command, responsavel: config.defaultResponsavel });
    }
  } catch {
    output({ ok: false, error: "config_invalid", message: "configuration could not be loaded" });
    process.exitCode = 1;
  }
}
