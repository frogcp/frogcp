import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('frogcp/admin: missing "#root" element; index.html is malformed');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
