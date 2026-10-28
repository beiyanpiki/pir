import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

// Vite's BASE_URL is "/" in production and in dev. React Router's basename
// follows it, so a future re-mount under a prefix stays a one-line change.
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const basename = base === "" ? undefined : base;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);