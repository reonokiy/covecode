import * as Linking from "expo-linking";
import * as AuthSession from "expo-auth-session";
import { useGT } from "gt-react-native";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useMobileCloudAuth } from "../cloud/useMobileCloudAuth";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
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
    const redirectUri = AuthSession.makeRedirectUri({
      scheme: Linking.createURL("/").split(":")[0],
    });
    return (
      <View style={styles.container}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => void signIn(redirectUri)}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>{gt("Sign in to T3 Connect")}</Text>
        </TouchableOpacity>
      </View>
    );
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
