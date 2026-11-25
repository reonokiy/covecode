import type { RelayEnvironmentEndpointFailure } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClientError from "effect/http/HttpClientError";

export interface EndpointFailureDiagnosis {
  readonly endpointFailure: RelayEnvironmentEndpointFailure;
  readonly endpointStatus?: number;
}

/**
 * Classifies HTTP error responses returned by the libp2p tunnel gateway or reverse proxy.
 */
export function classifyEndpointResponse(
  status: number,
  body: string,
): RelayEnvironmentEndpointFailure {
  if (body.includes('"tunnel_unavailable"') || body.includes('"libp2p_disabled"')) {
    return "tunnel_down";
  }
  if (body.includes('"tunnel_upstream_failed"')) {
    return "origin_unreachable";
  }
  if (status === 530 && body.includes("1016")) {
    return "dns";
  }
  switch (status) {
    case 530:
      return "tunnel_down";
    case 502:
    case 503:
      return "origin_unreachable";
    case 521:
      return "refused";
    case 504:
    case 522:
    case 524:
      return "timeout";
    case 525:
    case 526:
      return "tls";
    default:
      return "invalid_response";
  }
}

/** Reads the error code from the transport failure's cause chain, such as undici's `ECONNREFUSED`. */
export function classifyTransportFailure(cause: unknown): RelayEnvironmentEndpointFailure {
  const parts: Array<string> = [];
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = "code" in current ? current.code : undefined;
    parts.push(current.message, typeof code === "string" ? code : "");
    current = current.cause;
  }
  const text = parts.join(" ");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b/i.test(text)) return "dns";
  if (/ECONNREFUSED|refused/i.test(text)) return "refused";
  if (/CERT|\bTLS\b|\bSSL\b|certificate/i.test(text)) return "tls";
  if (/ETIMEDOUT|TIMEOUT|timed out/i.test(text)) return "timeout";
  return "unknown";
}

const ERROR_BODY_READ_TIMEOUT = Duration.seconds(2);

/** Turns a failed environment request into the cause the client shows the user. */
export const diagnoseEndpointFailure = Effect.fnUntraced(function* (cause: unknown) {
  if (!HttpClientError.isHttpClientError(cause)) {
    return { endpointFailure: "invalid_response" } satisfies EndpointFailureDiagnosis;
  }
  const response = cause.response;
  if (response === undefined) {
    return {
      endpointFailure:
        cause.reason._tag === "TransportError"
          ? classifyTransportFailure(cause.reason.cause)
          : "unknown",
    } satisfies EndpointFailureDiagnosis;
  }
  const body =
    response.status === 502 || response.status === 530
      ? Option.getOrElse(
          yield* response.text.pipe(
            Effect.timeoutOption(ERROR_BODY_READ_TIMEOUT),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
          () => "",
        )
      : "";
  return {
    endpointFailure: classifyEndpointResponse(response.status, body),
    endpointStatus: response.status,
  } satisfies EndpointFailureDiagnosis;
});
