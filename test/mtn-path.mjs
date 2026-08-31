import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localMtn = fileURLToPath(new URL("../../repos/mdbase-tasknotes/dist/cli.js", import.meta.url));

function sharedWorktreeMtn() {
  try {
    const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    }).trim();
    return join(dirname(commonGitDir), "repos", "mdbase-tasknotes", "dist", "cli.js");
  } catch {
    return null;
  }
}

export const mtn = process.env.MTN_PATH
  ?? [localMtn, sharedWorktreeMtn()].find((path) => path && existsSync(path))
  ?? localMtn;
