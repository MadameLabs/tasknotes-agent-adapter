#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { parseHookPayload } from "./hooks.mjs";
import { openState } from "./state.mjs";
import { sessionEnd } from "./domain.mjs";
import { createTaskNotesApiBackend } from "./backends/tasknotes-api.mjs";

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
    } else if (command === "hook-start" || command === "hook-end") {
      const agent = process.argv[process.argv.indexOf("--agent") + 1];
      const input = await new Promise((resolve) => { let raw = ""; process.stdin.on("data", (chunk) => raw += chunk); process.stdin.on("end", () => resolve(raw ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {})); });
      const hook = parseHookPayload(agent, command === "hook-start" ? "SessionStart" : "Stop", input);
      if (command === "hook-end") {
        const state = await openState(config.stateDir);
        const api = createTaskNotesApiBackend(config.desktop);
        await sessionEnd({ state, api, sessionKey: hook.sessionKey });
      }
      output({ ok: true, hookSpecificOutput: { hookEventName: hook.event, additionalContext: `TaskNotes adapter ready; responsavel padrao: ${config.defaultResponsavel}.` } });
    } else {
      output({ ok: true, command, responsavel: config.defaultResponsavel });
    }
  } catch {
    output({ ok: false, error: "config_invalid", message: "configuration could not be loaded" });
    process.exitCode = 1;
  }
}
