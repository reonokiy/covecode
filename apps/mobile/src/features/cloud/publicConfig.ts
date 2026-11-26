import Constants from "expo-constants";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

const selectionKey = "cove.control-plane";
let selectedOrigin: string | null = null;
let loaded: Promise<void> | undefined;

export function loadControlPlaneSelection(): Promise<void> {
  loaded ??= (async () => {
    const { whenProtectedDataAvailable } = await import("../../lib/protectedData");
    await whenProtectedDataAvailable();
    const storage = await import("expo-secure-store");
    const stored = await storage.getItemAsync(selectionKey);
    selectedOrigin = normalizeSecureRelayUrl(stored ?? "") ?? bundledControlPlane();
  })().catch(() => {
    // Local connections still work when startup storage is unavailable.
    selectedOrigin = null;
  });
  return loaded;
}

export async function rememberControlPlane(origin: string) {
  const storage = await import("expo-secure-store");
  await storage.setItemAsync(selectionKey, origin);
}

export interface CloudPublicConfig {
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly telemetryEnabled: boolean;
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function bundledControlPlane(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? "");
}

export function resolveCloudPublicConfig(overrides?: ExpoExtra) {
  const extra = overrides ?? Constants.expoConfig?.extra;
  return {
    relay: {
      url: overrides ? bundledControlPlane(overrides) : selectedOrigin,
    },
    observability: {
      telemetryEnabled: extra?.observability?.telemetryEnabled === true,
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

// Drafts from existing installations already belong to the bundled CP.
export function cloudDraftOwner(accountId: string) {
  const current = resolveCloudPublicConfig().relay.url;
  return !current || current === bundledControlPlane()
    ? accountId
    : JSON.stringify([current, accountId]);
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return config.relay.url !== null;
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.telemetryEnabled &&
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}
