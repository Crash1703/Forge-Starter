import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applySettings, loadSettings } from "./lib/settings";
import { reportErrors } from "./lib/feedback";

// Before the first paint, so a dark-theme rider never sees a white flash.
applySettings(loadSettings());
// Errors nothing else caught go to Ride Forge's server, so they can be fixed.
reportErrors();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
