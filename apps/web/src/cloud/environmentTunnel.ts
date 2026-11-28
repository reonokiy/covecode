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
    const { openWebPeer } = await import("./browserTunnel");
    if (window.desktopBridge) {
      const { openDesktopPeer } = await import("./desktopPeer");
      return openWebPeer(input, openDesktopPeer);
    }
    return openWebPeer(input);
  },
});
