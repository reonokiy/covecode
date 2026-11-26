import {
  readHostedPairingRequest,
  readPairingAppLink,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

function unwrapMobilePairingLink(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  return readPairingAppLink(trimmed) ?? trimmed;
}

export function readPinnedPairingUrl(rawValue: string | undefined): string | null {
  const trimmed = rawValue?.trim() ?? "";
  if (!trimmed) return null;
  const pairingUrl = unwrapMobilePairingLink(trimmed);
  try {
    return resolveRemotePairingTarget({ pairingUrl }).lanPeer ? pairingUrl : null;
  } catch {
    return null;
  }
}

export function resolveRoutePairingUrl(rawValue: string | undefined): string {
  const pinned = readPinnedPairingUrl(rawValue);
  if (pinned !== null) return pinned;
  if (!__DEV__) return "";
  return unwrapMobilePairingLink(rawValue ?? "");
}

function setTokenPreservingFragment(url: URL, token: string): string {
  url.searchParams.delete("token");
  const existingHashParams = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  const nextHashParams = new URLSearchParams([["token", token]]);
  for (const [key, value] of existingHashParams) {
    if (key !== "token") {
      nextHashParams.append(key, value);
    }
  }
  url.hash = nextHashParams.toString();
  return url.toString();
}

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return m(msg("Scanned QR code did not contain a pairing URL."));
  }
}

export function buildPairingUrl(host: string, code: string, sourcePairingUrl?: string): string {
  const h = unwrapMobilePairingLink(host);
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`);
    const unwrappedSource = sourcePairingUrl ? unwrapMobilePairingLink(sourcePairingUrl) : "";
    if (unwrappedSource) {
      try {
        const sourceUrl = new URL(unwrappedSource);
        const parsedHost = parsePairingUrl(url.toString()).host;
        const parsedSource = parsePairingUrl(sourceUrl.toString());
        if (parsedSource.host && parsedSource.host === parsedHost) {
          return setTokenPreservingFragment(sourceUrl, c);
        }
      } catch {}
    }
    return setTokenPreservingFragment(url, c);
  } catch {
    return `${h}#token=${c}`;
  }
}

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = unwrapMobilePairingLink(url);
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = new URL(trimmed);
    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const unwrapped = unwrapMobilePairingLink(payload);
  if (!unwrapped) {
    throw new PairingQrPayloadEmptyError({});
  }
  return unwrapped;
}
