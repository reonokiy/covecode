import { msg } from "gt-react";
import { createEnvironmentTunnels } from "@t3tools/client-runtime/relay";
import { m } from "../i18n/messages";

export const environmentTunnels = createEnvironmentTunnels({
  async verifyPeer(environmentId, peerId) {
    const key = "cove.peer." + environmentId;
    if (localStorage.getItem(key) === peerId) return;
    if (
      !window.confirm(
        m(
          msg("Run cove connect peer-id on your computer. Confirm only if it shows {peerId}.", {
            peerId,
          }),
        ),
      )
    )
      throw new Error("Environment identity was not verified");
    localStorage.setItem(key, peerId);
  },
  async open(input) {
    const bridge = window.desktopBridge;
    if (bridge) {
      const { openEnvironmentTunnel, closeEnvironmentTunnel } = bridge;
      if (!openEnvironmentTunnel || !closeEnvironmentTunnel)
        throw new Error("Desktop tunnel is unavailable");
      const url = await openEnvironmentTunnel(input);
      return {
        httpBaseUrl: url + "/",
        wsBaseUrl: url.replace(/^http:/u, "ws:") + "/ws",
        close: () => {
          void closeEnvironmentTunnel(url);
        },
      };
    }
    const { openWebPeer } = await import("./browserTunnel");
    return openWebPeer(input);
  },
});
