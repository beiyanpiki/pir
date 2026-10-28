import { Button, Result } from "antd";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Page not found" subtitle="The workspace has no route for this address." />
      <Result
        status="404"
        title="404"
        subTitle="This view does not exist, or the link is stale."
        extra={<Button type="primary" onClick={() => navigate("/projects")}>Back to projects</Button>}
      />
    </div>
  );
}
