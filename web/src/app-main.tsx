// The dashboard page (/app): the real hub.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./dashboard";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
