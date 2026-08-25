import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyDocumentLocale, getInitialUiLocale } from "./i18n.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Renderer root is missing");
}

// Apply the persisted/detected language before the first paint so CJK
// typography and assistive-technology metadata match the initial UI copy.
applyDocumentLocale(getInitialUiLocale());

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
