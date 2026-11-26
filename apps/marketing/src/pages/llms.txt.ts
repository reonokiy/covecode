import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL, MOBILE_README_URL } from "../lib/site";
import { SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which links are official for this fork.
export const GET: APIRoute = () => {
  const body = `# Cove Code

> ${SITE_TAGLINE}. Cove Code is an independent, MIT-licensed open-source fork of T3 Code (https://github.com/pingdotgg/t3code), not affiliated with T3 Tools, Inc. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents across desktop, web, and mobile.

Official desktop, CLI, and web client builds are published on GitHub Releases at ${GITHUB_REPOSITORY_URL}/releases, with container images at ghcr.io/reonokiy/cove-web and ghcr.io/reonokiy/cove-cp. There are no npm packages or mobile app store listings; the iOS and Android client is built from source.

## Official links

- [Download Cove Code](/download): macOS, Windows, and Linux desktop installers and CLI scripts
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): desktop, CLI, and web client release archives and changelogs
- [Web client image](https://github.com/reonokiy/covecode/pkgs/container/cove-web): self-hosted web client container (\`ghcr.io/reonokiy/cove-web\`)
- [Control panel image](https://github.com/reonokiy/covecode/pkgs/container/cove-cp): self-hosted control panel container (\`ghcr.io/reonokiy/cove-cp\`)
- [Mobile source build guide](${MOBILE_README_URL}): build the iOS and Android app from source (\`apps/mobile/README.md\`)

## Policies

- [Security policy](/security-policy)
- [Privacy policy](/privacy-policy)
- [Terms of service](/terms-of-service)
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
