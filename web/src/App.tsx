import { Navigate, Route, Routes } from "react-router-dom";
import { WorkspaceShell } from "./layout/WorkspaceShell";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <WorkspaceShell>
            <Routes>
              <Route path="/" element={<Navigate to="/projects" replace />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<RunsPage />} />
              <Route path="/runs/:projectId/:runId" element={<RunDetailPage />} />
              <Route path="*" element={<div className="empty-state">Page not found.</div>} />
            </Routes>
          </WorkspaceShell>
        }
      />
    </Routes>
  );
}
