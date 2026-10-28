// Small display helpers shared across pages.

export function shortSha(sha: string | null | undefined, length = 8): string {
  if (!sha) return "—";
  if (sha === "(snapshot)") return "snapshot";
  return sha.slice(0, length);
}

export function fmtTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return "—";
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleTimeString();
}

export function relTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return "—";
  const delta = Date.now() - epochMs;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? "ago" : "from now";
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) < 10_000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function fmtCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function fmtBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

export const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Guess a highlight.js language from a file path or tool name. */
export function languageForPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", markdown: "markdown",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
    sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml",
    toml: "ini", ini: "ini", sql: "sql", html: "xml", xml: "xml", css: "css",
    tf: "hcl", dockerfile: "dockerfile",
  };
  if (/\bDockerfile$/i.test(filePath)) return "dockerfile";
  return map[extension];
}
