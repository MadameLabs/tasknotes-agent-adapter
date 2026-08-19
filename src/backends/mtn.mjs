import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function createMtnBackend({ mtnPath, vaultPath, mtnArgs = [] }) {
  async function invoke(args) {
    try {
      const { stdout } = await run(mtnPath, [...mtnArgs, ...args, "--path", vaultPath], { windowsHide: true });
      return stdout;
    } catch (error) {
      throw new Error(`mtn_failed:${error.code ?? "unknown"}`);
    }
  }
  return {
    setStatus: (path, status) => invoke(["update", path, "--set", `status=${status}`]),
    startTimer: async (path) => { await invoke(["timer", "start", path]); return { taskPath: path }; },
    stopTimer: (path) => invoke(["timer", "stop", path]),
    verifyTimer: async () => false,
    createTask: () => { throw new Error("unsafe_backend_missing"); },
    getTask: () => { throw new Error("unsafe_backend_missing"); },
    listOpen: () => { throw new Error("unsafe_backend_missing"); },
    getActiveTimers: () => { throw new Error("unsafe_backend_missing"); },
  };
}
