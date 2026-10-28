import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

// Vite's BASE_URL is "/next/" while the new workspace is mounted next to the
// legacy app, and "/" after the migration. React Router's basename follows it,
// so links stay correct in both phases.
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const basename = base === "" ? undefined : base;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
