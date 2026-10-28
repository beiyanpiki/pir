import type { ReactNode } from "react";
import { Breadcrumb, Space } from "antd";
import { Link } from "react-router-dom";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: Array<{ title: ReactNode; to?: string }>;
}) {
  return (
    <div className="pir-page-head">
      <div style={{ minWidth: 0 }}>
        {breadcrumb && breadcrumb.length > 0 && (
          <Breadcrumb
            style={{ marginBottom: 8 }}
            items={breadcrumb.map((item) => ({ title: item.to ? <Link to={item.to}>{item.title}</Link> : item.title }))}
          />
        )}
        {eyebrow && <div className="pir-page-eyebrow">{eyebrow}</div>}
        <Space align="center" size={10} wrap>
          <h1 className="pir-page-title">{title}</h1>
        </Space>
        {subtitle && <div className="pir-page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="pir-page-actions">{actions}</div>}
    </div>
  );
}
