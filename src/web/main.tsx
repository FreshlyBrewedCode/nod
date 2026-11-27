/** The web entry: mounts the app; registers the service worker and hears the install prompt. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { listenForInstall } from "./hooks/use-install";
import { registerServiceWorker } from "./lib/sw-register";
import "./styles.css";

listenForInstall();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
