# Product usage data

All telemetry and diagnostic reporting channels in Cove Code are **disabled by default**. Cove Code
does not send product analytics, relay traces, or mobile crash reports unless you explicitly opt in
and configure a destination endpoint.

## Product analytics (opt-in)

Product usage events are off by default and ship with no default ingest endpoint or API key. To opt
in and send events to your own PostHog-compatible collector, set all three environment variables
before starting the server:

- `T3CODE_TELEMETRY_ENABLED=true`
- `T3CODE_POSTHOG_HOST=<your collector URL>`
- `T3CODE_POSTHOG_KEY=<your project key>`

When enabled, events are associated with a hashed account or installation identifier and include the
provider, model, reasoning effort, permission mode, turn and request results, duration, release
channel, and token counts when available. Child-agent token counts are reported separately from the
main agent's. Model names are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics (opt-in)

Relay connection tracing is disabled by default across the server, desktop app, web app, and mobile
app.

To opt in for the server or desktop app, set `T3CODE_TELEMETRY_ENABLED=true` (and configure the
relay tracing OTLP URL, dataset, and token). Relay tracing stays off when `T3CODE_OTEL_SDK_DISABLED`
or `OTEL_SDK_DISABLED` disables OpenTelemetry export.

An administrator can enforce telemetry off in the server and desktop app with a
[managed policy](./managed-policy.md#other-capabilities).

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on
macOS and Linux. On Windows, set it as a user environment variable.

The browser web app keeps relay tracing off by default unless built with
`VITE_T3CODE_TELEMETRY_ENABLED=true` and explicit `VITE_RELAY_OTLP_TRACES_*` settings.

## Mobile app diagnostics (opt-in)

Mobile crash reporting and relay connection tracing are disabled by default. Builds default the
crash report endpoint to a non-routable `.invalid` address and omit any default OTLP trace URL.

If a build explicitly enables telemetry (`EXPO_PUBLIC_TELEMETRY_ENABLED=true`) with a relay URL,
**Send crash reports** in **Settings > About Cove Code > Diagnostics** still starts off until you
turn it on.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the configured relay for
[mobile notifications and live activities](./mobile-notifications.md). This is off by default on the
server until enabled under **Settings > Sharing & access**.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
