import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sha256 } from "../core/types.js";
import { getRemoteUrl, getRootCommit, normalizeRemoteUrl } from "../changes/git.js";

export interface ProjectIdentity {
  projectId: string;
  remote: string | null;
  normalizedRemote: string | null;
  rootCommit: string;
}

/**
 * Project identity must survive clones, moves and machine changes, so it is
 * derived from the normalized git remote plus the root commit — never the
 * checkout path.
 */
export async function computeProjectIdentity(repoRoot: string): Promise<ProjectIdentity> {
  const [remote, rootCommit] = await Promise.all([getRemoteUrl(repoRoot), getRootCommit(repoRoot)]);
  const normalizedRemote = remote ? normalizeRemoteUrl(remote) : null;
  const projectId = sha256(`${normalizedRemote ?? "local"}\u0000${rootCommit}`);
  return { projectId, remote, normalizedRemote, rootCommit };
}

export { normalizeRemoteUrl };

/**
 * Per-project state directory holding memory.sqlite.
 * Linux: $XDG_STATE_HOME (~/.local/state)/pir/<projectId>/
 * macOS: ~/Library/Application Support/pir/<projectId>/
 * Windows: %APPDATA%\pir\<projectId>\
 */
export function projectStateDir(projectId: string, home = homedir()): string {
  const appName = "pir";
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", appName, projectId);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, appName, projectId);
  }
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  return path.join(xdgState, appName, projectId);
}

export function memoryDbPath(projectId: string, home = homedir()): string {
  return path.join(projectStateDir(projectId, home), "memory.sqlite");
}

export function ensureStateDir(projectId: string, home = homedir()): string {
  const dir = projectStateDir(projectId, home);
  mkdirSync(dir, { recursive: true });
  return dir;
}
