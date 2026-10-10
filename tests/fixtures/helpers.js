import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Create a temporary git repository with an initial commit. Returns helpers
 * for adding files and commits so tests can build fixture histories.
 */
export function createTempGitRepo(prefix = "pir-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@pir.local"]);
  git(dir, ["config", "user.name", "pir test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);

  return {
    dir,
    write(filePath, content) {
      const abs = path.join(dir, filePath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    commit(message = "commit", files = null) {
      if (files === null) git(dir, ["add", "-A"]);
      else if (files.length > 0) git(dir, ["add", "--", ...files]);
      git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
      return git(dir, ["rev-parse", "HEAD"]).trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * Submit a verifier verdict the way the evidence gate requires (Q3): one
 * pinned head read of `path`, then a rationale citing it. Scripted verifier
 * sessions in the integration suites must model this contract — a bare
 * submit_verdict is rejected as evidence-free.
 */
export async function submitVerdictWithEvidence(tool, verdict, path = "src/pay.ts") {
  await tool("read_code").execute({ path });
  return tool("submit_verdict").execute({
    ...verdict,
    rationale: `${verdict.rationale} Evidence: read ${path}:1.`,
  });
}
