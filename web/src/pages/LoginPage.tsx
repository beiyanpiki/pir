import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, getToken, setToken } from "../api";

export function LoginPage() {
  const navigate = useNavigate();
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setChecking(true);
    setError(null);
    setToken(token.trim() || null);
    try {
      await apiGet("/api/overview");
      navigate("/projects");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setChecking(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-[380px] rounded-2xl border border-border bg-card p-7 shadow-2xl shadow-black/40"
      >
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-lg font-bold text-primary">
            ⌄
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight">pir review</h1>
            <p className="text-xs text-muted-foreground">review run observer</p>
          </div>
        </div>
        <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
          Read-only explorer for review runs. This UI never starts reviews — it only shows what
          ran. Enter the server's <code className="font-mono text-foreground/80">PIR_WEB_UI_TOKEN</code>.
          {getToken() === null && " (leave empty if the server runs tokenless on loopback)"}
        </p>
        <input
          type="password"
          placeholder="PIR_WEB_UI_TOKEN"
          value={token}
          autoFocus
          onChange={(event) => setTokenValue(event.target.value)}
          className="mb-3.5 w-full rounded-lg border border-input bg-input/40 px-3.5 py-2.5 font-mono text-[13px] outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/70"
        />
        {error && <div className="mb-3.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        <button
          type="submit"
          disabled={checking}
          className="w-full rounded-lg bg-primary py-2.5 text-[13.5px] font-semibold text-primary-foreground transition-[filter] hover:brightness-110 disabled:opacity-50"
        >
          {checking ? "checking…" : "sign in"}
        </button>
      </form>
    </div>
  );
}
