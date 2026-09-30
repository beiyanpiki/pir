import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input } from "@heroui/react";
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
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <form
        onSubmit={(event) => void submit(event)}
        style={{
          width: 360, background: "var(--pir-panel)", border: "1px solid var(--pir-border)",
          borderRadius: 14, padding: 28,
        }}
      >
        <h1 style={{ fontSize: 17, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            width: 28, height: 28, borderRadius: 7, background: "#141a22",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            color: "var(--pir-accent)", fontSize: 16,
          }}>⌄</span>
          pir review
        </h1>
        <p style={{ color: "var(--pir-dim)", fontSize: 12.5, margin: "0 0 18px" }}>
          Read-only explorer for review runs. This UI never starts reviews — it
          only shows what ran. Enter the server's <code>PIR_WEB_UI_TOKEN</code>.
          {getToken() === null && " (leave empty if the server runs tokenless on loopback)"}
        </p>
        <Input
          type="password"
          placeholder="PIR_WEB_UI_TOKEN"
          value={token}
          autoFocus
          onChange={(event) => setTokenValue(event.target.value)}
          style={{ marginBottom: 14 }}
        />
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <Button type="submit" variant="primary" isDisabled={checking} style={{ width: "100%" }}>
          {checking ? "checking…" : "sign in"}
        </Button>
      </form>
    </div>
  );
}
