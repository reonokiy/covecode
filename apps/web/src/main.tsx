import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { startCloudAuth } from "./cloud/oidcAuth";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

export const startup = (async () => {
  const query = new URLSearchParams(window.location.search);
  // Restore the pre-login route before the router reads its initial location.
  if (query.has("state") && (query.has("code") || query.has("error"))) await startCloudAuth();
  const router = startAppServices();
  await router.load().then(whenLocaleReady);
  if (reloadScheduled) return;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ManagedRelayAuthProvider>
        <AppRoot router={router} />
      </ManagedRelayAuthProvider>
    </React.StrictMode>,
  );
})().catch((error: unknown) => {
  if (reloadScheduled) return;
  throw error;
});
