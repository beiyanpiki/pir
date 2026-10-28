import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { KeyOutlined, LoginOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { apiGet, ApiError, getToken, setToken } from "../lib/api";
import { useThemeMode } from "../theme";

interface LoginForm {
  token: string;
}

function safeFrom(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/projects";
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { mode } = useThemeMode();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = safeFrom((location.state as { from?: unknown } | null)?.from);

  const submit = async (values: LoginForm): Promise<void> => {
    setChecking(true);
    setError(null);
    const token = values.token?.trim() ?? "";
    setToken(token || null);
    try {
      await apiGet("/api/overview");
      navigate(from, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setToken(null);
        setError("That token was rejected. Check PIR_WEB_UI_TOKEN on the server.");
      } else if (cause instanceof ApiError) {
        setError(`The server answered ${cause.status}: ${cause.message}`);
      } else {
        setError(cause instanceof Error ? cause.message : "Could not reach the review server.");
      }
      setChecking(false);
    }
  };

  return (
    <div className="pir-login-wrap" data-theme={mode}>
      <Card className="pir-login-card">
        <div className="pir-login-brand">
          <span className="pir-brand-mark" style={{ width: 38, height: 38, fontSize: 18 }}>π</span>
          <div>
            <h1>pir review</h1>
            <p>Read-only review workspace</p>
          </div>
        </div>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          This workspace observes review runs and their evidence. It never starts, cancels, or edits a review.
        </Typography.Paragraph>

        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 14 }} />}

        <Form<LoginForm> layout="vertical" onFinish={(values) => void submit(values)} initialValues={{ token: "" }}>
          <Form.Item
            name="token"
            label={<span><KeyOutlined /> Access token</span>}
            extra={`Server credential: PIR_WEB_UI_TOKEN${getToken() === null ? " · optional on loopback binds" : ""}`}
          >
            <Input.Password autoFocus placeholder="Paste the viewer token" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={checking} icon={<LoginOutlined />} block size="large">
            Open workspace
          </Button>
        </Form>

        <div className="pir-muted" style={{ marginTop: 16, fontSize: 12 }}>
          <SafetyCertificateOutlined /> The token is stored in this browser only and sent in the Authorization header.
        </div>
      </Card>
    </div>
  );
}
