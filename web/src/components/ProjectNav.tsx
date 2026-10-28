import { Tabs } from "antd";
import { useLocation, useNavigate, useParams } from "react-router-dom";

/**
 * Project-scoped navigation. It lives in the page chrome, not the sidebar, so
 * the same project context is visible at every width.
 */
export function ProjectNav() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const suffix = location.pathname.startsWith(`/projects/${projectId}`) ? location.pathname.slice(`/projects/${projectId}`.length).replace(/^\//, "") : "";
  const active = suffix === "" ? "runs" : suffix;
  return (
    <Tabs
      activeKey={active}
      onChange={(key) => navigate(key === "runs" ? `/projects/${projectId}` : `/projects/${projectId}/${key}`)}
      items={[
        { key: "runs", label: "Runs" },
        { key: "findings", label: "Findings" },
        { key: "memory", label: "Memory" },
        { key: "feedback", label: "Feedback" },
        { key: "compare", label: "Compare" },
      ]}
      style={{ marginBottom: 4 }}
    />
  );
}
