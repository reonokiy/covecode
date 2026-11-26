import { requireNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { msg } from "gt-react-native";
import { createEnvironmentTunnels } from "@t3tools/client-runtime/relay";
import { m } from "../../i18n/messages";

interface NativeTunnel {
  open(endpoint: string): Promise<string>;
  close(url: string): void;
}

export const environmentTunnels = createEnvironmentTunnels({
  async verifyPeer(environmentId, peerId) {
    const key = `cove.peer.${environmentId}`;
    const saved = await SecureStore.getItemAsync(key);
    if (saved === peerId) return;
    const { Alert } = await import("react-native");
    const confirmed = await new Promise<boolean>((resolve) =>
      Alert.alert(
        m(msg("Verify environment identity")),
        m(
          msg("Run cove connect peer-id on your computer. Confirm only if it shows {peerId}.", {
            peerId,
          }),
        ),
        [
          { text: m(msg("Cancel")), style: "cancel", onPress: () => resolve(false) },
          { text: m(msg("Confirm")), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!confirmed) throw new Error("Environment identity was not verified");
    await SecureStore.setItemAsync(key, peerId);
  },
  async open(input) {
    const native = requireNativeModule<NativeTunnel>("CoveP2p");
    const httpBaseUrl = await native.open(JSON.stringify(input));
    return {
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace(/^http:/u, "ws:") + "ws",
      close: () => native.close(httpBaseUrl),
    };
  },
});
