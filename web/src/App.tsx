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
          <div className="app-shell flex h-screen overflow-hidden">
            <Sidebar />
            <main className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:projectId" element={<RunsPage />} />
                <Route path="/runs/:projectId/:runId" element={<RunDetailPage />} />
                <Route path="*" element={<div className="pir-empty">Nothing here.</div>} />
              </Routes>
            </main>
          </div>
        }
      />
    </Routes>
  );
}
