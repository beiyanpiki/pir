/** How a language pack got selected for a run. */
export type PluginActivation = "auto" | "manual";

/** A built-in language pack loaded from plugins/<name>/. */
export interface LanguagePack {
  /** Stable identifier used by --plugins and envelopes. */
  name: string;
  /** Human-facing label, e.g. "Go". */
  title: string;
  /** Pack content version, bumped when guidance changes. */
  version: string;
  /** Repo-relative files whose presence at the reviewed head activates the pack. */
  markerFiles: string[];
  /** File extensions (without dot) the pack covers, for language-aware file listing. */
  extensions: string[];
  /** Reviewer-role guidance (markdown), injected as trusted review directions. */
  reviewerGuidance: string;
  /** Verifier-role guidance (markdown), injected as trusted review directions. */
  verifierGuidance: string;
  /**
   * Audit-mode variants (current-state phrasing, no change attribution).
   * Optional: a pack without them stays change-only and its guidance is
   * withheld from audit sessions instead of demanding diff attribution.
   */
  reviewerAuditGuidance?: string;
  verifierAuditGuidance?: string;
}

/** A pack selected for a run, with how it was selected. */
export interface ActivePack {
  name: string;
  version: string;
  activation: PluginActivation;
}

export type PluginMode = "auto" | "manual" | "off";

/** Selection parsed from --plugins (or the auto default). */
export interface PluginSelection {
  mode: PluginMode;
  /** Pack names for mode "manual". */
  manual: string[];
}

/** Guidance resolution result consumed by the finding loop. */
export interface LanguagePackRun {
  active: ActivePack[];
  reviewerGuidance: string;
  verifierGuidance: string;
}
