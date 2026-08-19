#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { parseHookPayload } from "./hooks.mjs";
import { openState } from "./state.mjs";
import { sessionEnd } from "./domain.mjs";
import { startWork, stopWork } from "./domain.mjs";
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
    } else if (command === "start" || command === "stop") {
      const taskPath = process.argv[3];
      const agent = process.argv[process.argv.indexOf("--agent") + 1];
      const sessionId = process.argv[process.argv.indexOf("--session") + 1];
      if (!agent || !sessionId || (command === "start" && !taskPath)) throw new Error("missing_session_or_task");
      const state = await openState(config.stateDir);
      const api = createTaskNotesApiBackend(config.desktop);
      const sessionKey = `${agent}:${sessionId}`;
      const result = command === "start"
        ? await startWork({ state, api, sessionKey, vault: config.vault, taskPath })
        : await stopWork({ state, api, sessionKey, status: "pausa" });
      output({ ok: true, result });
    } else {
      output({ ok: true, command, responsavel: config.defaultResponsavel });
    }
  } catch {
    output({ ok: false, error: "config_invalid", message: "configuration could not be loaded" });
    process.exitCode = 1;
  }
}
