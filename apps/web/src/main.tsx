import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { startCloudAuth } from "./cloud/oidcAuth";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// The OIDC config is fetched at runtime, so cloudless local mode pays nothing at startup.
const cloudAuth = hasCloudPublicConfig() ? startCloudAuth() : null;

export const startup = Promise.all([
  cloudAuth,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    const tree = cloudAuth ? <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider> : app;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{tree}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
