import Constants from "expo-constants";
import { Observe } from "expo-observe";

// Importing expo-observe installs its global JS error handler; reports leave only through the relay
// when explicitly opted in at build time and enabled in settings.
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const observeEndpointUrl: unknown = Constants.expoConfig?.extra?.eas?.observe?.endpointUrl;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

export const crashReportingAvailable =
  typeof relayUrl === "string" &&
  relayUrl.trim() !== "" &&
  typeof observeEndpointUrl === "string" &&
  observeEndpointUrl.trim() !== "" &&
  observeEndpointUrl !== "https://observe.invalid";

let crashReportsEnabled = false;

export function reportCrashError(error: unknown) {
  if (!crashReportingAvailable || !crashReportsEnabled) {
    return;
  }
  Observe.reportError(error);
}

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
const isDev = typeof __DEV__ !== "undefined" && __DEV__;
if (!isDev && crashReportingAvailable) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => reportCrashError(rejection),
  });
}

let latestConfiguration = 0;

// While sending is off, a dispatch pass drops what it finds, so one runs before turning it back on.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  crashReportsEnabled = dispatchingEnabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    if (configuration !== latestConfiguration) return;
  }
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
} else {
  // Crash reporting defaults off; load persisted preferences to check for explicit opt-in.
  // Imported lazily so the persistence graph never runs ahead of the imports `index.ts` orders first.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled === true),
      (error: unknown) => {
        console.warn("[observe] could not read the crash report setting", error);
        return changedSinceLoad() ? undefined : setCrashReportsEnabled(false);
      },
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
