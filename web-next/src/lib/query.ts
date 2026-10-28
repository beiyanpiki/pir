import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/** URL-backed list state: refresh, back/forward and sharing keep the view. */
export function useQueryState(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const get = useCallback((key: string): string => params.get(key) ?? defaults[key] ?? "", [params, defaults]);
  const update = useCallback((changes: Record<string, string | number | null>, replace = false): void => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    }, { replace });
  }, [setParams]);
  const reset = useCallback((keys: string[], replace = false): void => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const key of keys) next.delete(key);
      return next;
    }, { replace });
  }, [setParams]);
  return { params, get, update, reset };
}

/** Offset paging normalized to a 50-row page; invalid values fall back to 0. */
export function normalizeOffset(raw: string, pageSize = 50): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.floor(value / pageSize) * pageSize;
}
