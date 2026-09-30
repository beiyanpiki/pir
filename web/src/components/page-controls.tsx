import { AlertCircle, RefreshCw, Search, X } from "lucide-react";

export function SearchField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <label className="search-field">
      <Search size={16} aria-hidden="true" />
      <input type="search" value={value} aria-label={label} placeholder={label} onChange={(event) => onChange(event.target.value)} />
      {value && <button type="button" aria-label="Clear search" title="Clear search" onClick={() => onChange("")}><X size={15} /></button>}
    </label>
  );
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button className="icon-button" type="button" disabled={loading} aria-label="Refresh" title="Refresh" onClick={onClick}>
      <RefreshCw size={16} className={loading ? "spin" : ""} />
    </button>
  );
}

export function PageError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={19} />
      <span>{error}</span>
      <button className="text-command" type="button" onClick={retry}><RefreshCw size={14} /> Retry</button>
    </div>
  );
}
