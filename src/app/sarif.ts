import { buildIdentity } from "../findings/identity.js";
import type { FindingView } from "./find.js";
import { isReported } from "./output.js";

/**
 * SARIF 2.1.0 output for `find` and `audit` (ADR 0016 Part III).
 *
 * One log, one run: the tool driver describes pir and the finding categories
 * it reports, the invocation records whether the run completed (the same
 * `incomplete` flag the JSON envelope carries) and why it stopped, and every
 * reported finding becomes one result. The mapping is deliberately mechanical
 * — severity selects the level, the finding's canonical identity is the
 * partial fingerprint, anchors become physical locations — so the document
 * adds no claim the JSON envelope does not already make.
 */

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_VERSION = "2.1.0";
export const SARIF_TOOL_NAME = "pir";
export const SARIF_INFORMATION_URI = "https://github.com/beiyanpiki/pir";
/** Fingerprint key namespace: the finding's identity survives across runs. */
export const SARIF_FINGERPRINT_KEY = "pirFinding/v1";

export interface SarifInput {
  /** The command that produced the run. */
  command: "find" | "audit";
  /** pir's own version, for `tool.driver.version`. */
  version: string;
  /**
   * Verified rows as persisted, in reporting order. Only reported statuses
   * (confirmed, uncertain) become results — the verifier-rejected and
   * decision-suppressed rows the envelope still lists are not review output a
   * scanner should alert on, and `isReported` is the same predicate the text
   * report and the exit-code gate use.
   */
  findings: FindingView[];
  /** True when the run did not complete cleanly; the exit-code contract is unchanged. */
  incomplete: boolean;
  /** Why the run stopped; "" when it ran to completion. */
  stoppedBecause: string;
  /** Run identifier, recorded as an invocation property. */
  runId?: string | null;
  /** Audit coverage summary, recorded as an invocation property. */
  coverage?: Record<string, number> | null;
}

export type SarifLevel = "error" | "warning" | "note";

type SarifRegion = { startLine: number; endLine?: number };
type SarifLocation = {
  physicalLocation: { artifactLocation: { uri: string }; region: SarifRegion };
};

/** P0/P1 block, P2 warns, P3 notes — the same ranking the text report uses. */
export function sarifLevel(severity: string): SarifLevel {
  if (severity === "P0" || severity === "P1") return "error";
  if (severity === "P3") return "note";
  return "warning";
}

/**
 * `category` is the SARIF rule id. Categories are model-authored strings, so
 * the id is lowercased, runs of unsafe characters collapse to one dash, and an
 * empty result becomes "other" — a stable id is a contract, a raw string is not.
 */
export function sarifRuleId(category: string | null | undefined): string {
  const raw = (category ?? "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "other" : safe;
}

/** Percent-encode each path segment so `uri` is a valid URI reference. */
export function sarifUri(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** One anchor as a physical location; an unusable anchor yields null. */
function locationOf(anchor: FindingView["anchors"][number]): SarifLocation | null {
  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) return null;
  const endLine =
    anchor.endLine !== undefined && Number.isInteger(anchor.endLine) && anchor.endLine >= anchor.startLine
      ? anchor.endLine
      : undefined;
  return {
    physicalLocation: {
      artifactLocation: { uri: sarifUri(anchor.path) },
      region: endLine === undefined ? { startLine: anchor.startLine } : { startLine: anchor.startLine, endLine },
    },
  };
}

/**
 * One finding as one SARIF result. The fingerprint is the finding's canonical
 * identity (feature, entity, normalized category/claim/trigger) — the same
 * value the memory layer keys findings by — so a consumer can correlate a
 * result across runs without trusting the display id.
 */
function resultOf(finding: FindingView): Record<string, unknown> {
  const locations = finding.anchors
    .map(locationOf)
    .filter((location): location is SarifLocation => location !== null);
  const [primary, ...related] = locations;
  const identity = buildIdentity({
    featureKey: finding.featureKey ?? undefined,
    entityKey: finding.entityKey ?? undefined,
    category: finding.category,
    claim: finding.claim,
    trigger: finding.trigger,
  });
  return {
    ruleId: sarifRuleId(finding.category),
    level: sarifLevel(finding.severity),
    message: { text: finding.claim },
    ...(primary === undefined ? {} : { locations: [primary] }),
    ...(related.length === 0
      ? {}
      : { relatedLocations: related.map((location, index) => ({ id: index + 1, ...location })) }),
    partialFingerprints: { [SARIF_FINGERPRINT_KEY]: identity.fingerprint },
    properties: {
      displayId: finding.displayId,
      severity: finding.severity,
      status: finding.status,
      category: finding.category,
      ...(finding.confidence === null ? {} : { confidence: finding.confidence }),
    },
  };
}

/** One rule per distinct category, sorted, so two runs over the same set match. */
function rulesFor(findings: FindingView[]): Array<Record<string, unknown>> {
  return [...new Set(findings.map((finding) => sarifRuleId(finding.category)))].sort().map((id) => ({
    id,
    shortDescription: { text: `pir finding category: ${id}` },
  }));
}

/**
 * One invocation: `executionSuccessful` mirrors the envelope's `incomplete`,
 * and the stop reason rides along as a notification so a consumer sees the
 * same truncation the operator does. `--fail-on` exit codes are unchanged;
 * SARIF only changes stdout.
 */
function invocationOf(input: SarifInput): Record<string, unknown> {
  const stopped = input.stoppedBecause.trim();
  return {
    executionSuccessful: !input.incomplete,
    ...(stopped === ""
      ? {}
      : {
          toolExecutionNotifications: [
            { level: input.incomplete ? "warning" : "note", message: { text: input.stoppedBecause } },
          ],
        }),
    properties: {
      command: input.command,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.coverage ? { coverage: input.coverage } : {}),
    },
  };
}

/** Build the SARIF log document (no I/O; callers render or assert it). */
export function sarifLog(input: SarifInput): Record<string, unknown> {
  // Reported rows only (confirmed + uncertain). A verifier rejection or a
  // trusted prior decision (expected / false_positive / accepted_risk /
  // wont_fix) is not an alert: emitting it as a SARIF result would hand a
  // code scanner a finding pir itself dismissed.
  const reported = input.findings.filter(isReported);
  const rules = rulesFor(reported);
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            informationUri: SARIF_INFORMATION_URI,
            version: input.version,
            ...(rules.length === 0 ? {} : { rules }),
          },
        },
        invocations: [invocationOf(input)],
        results: reported.map(resultOf),
      },
    ],
  };
}

/** Pretty-printed, newline-terminated: stdout for `--format sarif`. */
export function renderSarif(input: SarifInput): string {
  return `${JSON.stringify(sarifLog(input), null, 2)}\n`;
}
