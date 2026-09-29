import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getToken, setToken } from "../api";
import { apiGet } from "../api";

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
    <div className="login-wrap">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1><span className="logo" style={{ width: 28, height: 28, borderRadius: 7, background: "#141a22", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", fontSize: 16 }}>⌄</span> pir review</h1>
        <p>
          Read-only explorer for review runs. This UI never starts reviews — it
          only shows what ran. Enter the server's <code>PIR_WEB_UI_TOKEN</code>.
          {getToken() === null && " (leave empty if the server runs tokenless on loopback)"}
        </p>
        <input
          type="password"
          placeholder="PIR_WEB_UI_TOKEN"
          value={token}
          autoFocus
          onChange={(event) => setTokenValue(event.target.value)}
        />
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn-primary" type="submit" disabled={checking}>
          {checking ? "checking…" : "sign in"}
        </button>
      </form>
    </div>
  );
}
