import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applySettings, loadSettings } from "./lib/settings";

// Before the first paint, so a dark-theme rider never sees a white flash.
applySettings(loadSettings());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
