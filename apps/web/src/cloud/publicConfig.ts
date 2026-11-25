import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

const TRUE_TELEMETRY_FLAGS = new Set(["true", "yes", "on", "1", "y"]);

let desktopRelayTelemetry: boolean | null = null;

function isWebRelayTelemetryOptedIn(): boolean {
  const raw = (import.meta.env.VITE_T3CODE_TELEMETRY_ENABLED as string | undefined)
    ?.trim()
    .toLowerCase();
  return raw !== undefined && TRUE_TELEMETRY_FLAGS.has(raw);
}

/** Whether relay spans may be exported now; defaults off unless explicitly enabled. */
export function relayTelemetryEnabled(): boolean | null {
  if (typeof window === "undefined" || !window.desktopBridge) {
    return isWebRelayTelemetryOptedIn();
  }
  desktopRelayTelemetry ??= window.desktopBridge.getRelayTelemetryEnabled();
  return desktopRelayTelemetry;
}

export function resolveRelayTracingConfig() {
  // The relay exporter is created during module initialization, so this must be synchronous.
  if (relayTelemetryEnabled() === false) {
    return null;
  }
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

/** Cloud is available when a relay URL is configured; OIDC settings come from the control plane at runtime. */
export function hasCloudPublicConfig(): boolean {
  return resolveCloudPublicConfig().relayUrl !== null;
}
