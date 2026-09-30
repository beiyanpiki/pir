import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { apiGet, getToken, setToken } from "../api";

export function LoginPage() {
  const navigate = useNavigate();
  const [token, setTokenValue] = useState("");
  const [visible, setVisible] = useState(false);
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
    <main className="login-page">
      <section className="login-panel">
        <header className="login-brand">
          <span className="brand-mark is-large"><ShieldCheck size={21} /></span>
          <div>
            <h1>pir review</h1>
            <p>Review workspace</p>
          </div>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <label className="login-label" htmlFor="web-token">
            <span><KeyRound size={14} /> Access token</span>
            <small>PIR_WEB_UI_TOKEN</small>
          </label>
          <div className="token-field">
            <input
              id="web-token"
              type={visible ? "text" : "password"}
              placeholder={getToken() === null ? "Optional on loopback" : "Enter access token"}
              value={token}
              autoFocus
              onChange={(event) => setTokenValue(event.target.value)}
            />
            <button
              type="button"
              aria-label={visible ? "Hide token" : "Show token"}
              title={visible ? "Hide token" : "Show token"}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error && <div className="error-state is-inline">{error}</div>}

          <button className="login-submit" type="submit" disabled={checking}>
            <LogIn size={15} />
            {checking ? "Checking…" : "Open workspace"}
          </button>
        </form>

        <footer><ShieldCheck size={12} /> Read-only review run explorer</footer>
      </section>
    </main>
  );
}
