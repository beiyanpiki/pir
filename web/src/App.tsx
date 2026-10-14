import { Navigate, Route, Routes } from "react-router-dom";
import { WorkspaceShell } from "./layout/WorkspaceShell";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";

import { ProjectKnowledgePage } from "./pages/ProjectKnowledgePage";
import { RunComparePage } from "./pages/RunComparePage";

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
              <Route path="/projects/:projectId/findings" element={<ProjectKnowledgePage kind="findings" />} />
              <Route path="/projects/:projectId/memory" element={<ProjectKnowledgePage kind="memory" />} />
              <Route path="/projects/:projectId/feedback" element={<ProjectKnowledgePage kind="feedback" />} />
              <Route path="/projects/:projectId/compare" element={<RunComparePage />} />
              <Route path="/runs/:projectId/:runId" element={<RunDetailPage />} />
              <Route path="*" element={<div className="empty-state">Page not found.</div>} />
            </Routes>
          </WorkspaceShell>
        }
      />
    </Routes>
  );
}
