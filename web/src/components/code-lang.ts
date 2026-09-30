import type { BundledLanguage } from "shiki";
import { languageForPath } from "../format";

/**
 * AI Elements' CodeBlock requires a shiki BundledLanguage. Shiki accepts the
 * plain-text alias at runtime but not in its type, so unknown extensions
 * converge here instead of leaking `undefined` into every call site.
 */
export function codeLanguage(pathOrLanguage: string | undefined): BundledLanguage {
  if (!pathOrLanguage) return "text" as BundledLanguage;
  const guessed = languageForPath(pathOrLanguage);
  return (guessed ?? "text") as BundledLanguage;
}
