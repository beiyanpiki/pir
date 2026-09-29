import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./layout/Sidebar";
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
          <div className="app-shell">
            <Sidebar />
            <main className="app-main">
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:projectId" element={<RunsPage />} />
                <Route path="/runs/:projectId/:runId" element={<RunDetailPage />} />
                <Route path="*" element={<div className="empty-state">Nothing here.</div>} />
              </Routes>
            </main>
          </div>
        }
      />
    </Routes>
  );
}
