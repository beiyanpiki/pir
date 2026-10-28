import { Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorkspaceLayout } from "./layout/WorkspaceLayout";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { ProjectKnowledgePage } from "./pages/ProjectKnowledgePage";
import { ComparePage } from "./pages/ComparePage";
import { NotFoundPage } from "./pages/NotFoundPage";

export function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<WorkspaceLayout />}>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<RunsPage />} />
          <Route path="/projects/:projectId/findings" element={<ProjectKnowledgePage kind="findings" />} />
          <Route path="/projects/:projectId/memory" element={<ProjectKnowledgePage kind="memory" />} />
          <Route path="/projects/:projectId/feedback" element={<ProjectKnowledgePage kind="feedback" />} />
          <Route path="/projects/:projectId/compare" element={<ComparePage />} />
          <Route path="/runs/:projectId/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        </Routes>
      </ErrorBoundary>
    </ThemeProvider>
  );
}