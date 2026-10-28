import type { ReactNode } from "react";
import { Alert, Button, Empty, Result, Skeleton, Space, Spin, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div style={{ padding: 48, textAlign: "center" }}>
      <Spin size="large" />
      <div className="pir-muted" style={{ marginTop: 12 }}>{label}</div>
    </div>
  );
}

export function InlineLoading({ label = "Loading…" }: { label?: string }) {
  return <Space><Spin size="small" /><span className="pir-muted">{label}</span></Space>;
}

export function PageError({ error, status, onRetry }: { error: string; status?: number | null; onRetry?: () => void }) {
  if (status === 404) {
    return (
      <Result
        status="404"
        title="Not found"
        subTitle={error}
        extra={<Button onClick={onRetry} icon={<ReloadOutlined />}>Retry</Button>}
      />
    );
  }
  return (
    <Alert
      type="error"
      showIcon
      title="This view could not be loaded"
      description={error}
      action={onRetry ? <Button size="small" onClick={onRetry} icon={<ReloadOutlined />}>Retry</Button> : undefined}
      style={{ marginTop: 16 }}
    />
  );
}

export function EmptyState({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="pir-empty-page">
      <Empty image={icon ?? Empty.PRESENTED_IMAGE_SIMPLE} description={<div><Typography.Text strong>{title}</Typography.Text>{description && <div className="pir-muted" style={{ marginTop: 6 }}>{description}</div>}</div>}>
        {action}
      </Empty>
    </div>
  );
}

export function PageSkeleton() {
  return <Skeleton active paragraph={{ rows: 6 }} />;
}
