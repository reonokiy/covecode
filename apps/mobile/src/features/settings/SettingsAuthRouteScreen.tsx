import { Button } from "../../components/ui/Button";
import * as Linking from "expo-linking";
import * as AuthSession from "expo-auth-session";
import { useGT } from "gt-react-native";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

import { AppTextInput } from "../../components/ui/AppText";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { useMobileCloudAuth } from "../cloud/useMobileCloudAuth";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";

export function SettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn, user, signIn, signOut } = useMobileCloudAuth();
  const navigation = useNavigation();
  const gt = useGT();
  const [hasBeenSignedIn, setHasBeenSignedIn] = useState(isSignedIn === true);
  if (isSignedIn && !hasBeenSignedIn) setHasBeenSignedIn(true);

  // Pop back when the user signs out from the profile page
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when OIDC session reports a sign-out from the profile page
  useEffect(() => {
    if (hasBeenSignedIn && isLoaded && isSignedIn === false) {
      navigation.goBack();
    }
  }, [hasBeenSignedIn, isLoaded, isSignedIn, navigation]);

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return <ControlPlaneSignIn signIn={signIn} />;
  }

  return (
    <View style={styles.container}>
      {user?.email ? <Text style={styles.email}>{user.email}</Text> : null}
      <T3ConnectProfilePage />
      <TouchableOpacity
        style={[styles.button, styles.signOutButton]}
        onPress={() => void signOut()}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{gt("Sign out")}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ControlPlaneSignIn({
  signIn,
}: {
  signIn: ReturnType<typeof useMobileCloudAuth>["signIn"];
}) {
  const gt = useGT();
  const [address, setAddress] = useState(() => resolveCloudPublicConfig().relay.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function submit() {
    if (busy || !normalizeSecureRelayUrl(address)) return;
    setBusy(true);
    setError(false);
    try {
      await signIn(
        AuthSession.makeRedirectUri({ scheme: Linking.createURL("/").split(":")[0] }),
        address,
      );
    } catch {
      setError(true);
    }
    setBusy(false);
  }
  return (
    <View style={styles.container} className="gap-3">
      <Text className="text-foreground">{gt("Control panel address")}</Text>
      <AppTextInput
        accessibilityLabel={gt("Control panel address")}
        placeholder="https://cp.example.com"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        value={address}
        onChangeText={(next) => {
          setAddress(next);
          setError(false);
        }}
        editable={!busy}
        onSubmitEditing={submit}
      />
      {address.trim().length > 0 && !normalizeSecureRelayUrl(address) && (
        <Text className="text-foreground-muted">
          {gt("Enter an HTTPS address, or use HTTP on localhost.")}
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {gt("Could not start sign-in. Check the control panel address and try again.")}
        </Text>
      )}
      <Button
        label={gt("Sign in to T3 Connect")}
        loading={busy}
        disabled={!normalizeSecureRelayUrl(address)}
        onPress={submit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  email: { fontSize: 14, color: "#666", marginBottom: 8 },
  button: {
    backgroundColor: "#0066cc",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
    marginTop: 16,
  },
  signOutButton: { backgroundColor: "#cc0000", marginTop: 24 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
