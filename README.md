<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="Cove Code logo" />
</p>

<h1 align="center">Cove Code</h1>

<p align="center">An unofficial, security-focused open-source fork based on the T3 Code source code.</p>

> **Unofficial Fork Notice**: Cove Code is an independent, unofficial project derived from the MIT-licensed [T3 Code](https://github.com/pingdotgg/t3code) source code (`v0.1.11`). It is **not affiliated with, endorsed by, or maintained by T3 Tools, Inc.** All T3 Code names, wordmarks, logos, and icons have been replaced.

## Overview

Cove Code runs the coding agents on your machine and gives them one fast, security-hardened interface across desktop, web, and mobile. It uses isolated local state (`~/.cove`), its own CLI binary (`cove`), URL scheme (`covecode://`), default port (`3774`), and application identifier (`net.nokiy.cove`) so it can coexist cleanly alongside other installations.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent.

## Releases

[Download Cove Code](https://github.com/reonokiy/covecode/releases) for desktop, the standalone CLI, or the web client. The matching Linux x64 control panel image is published as `ghcr.io/reonokiy/cove-cp:vX.Y.Z`.

Cove CI checks pushes and pull requests to `covecode`. To publish a stable release, push a new `vX.Y.Z` tag on a commit from that branch. GitHub Actions builds the platform archives, assembles the updater manifests and checksums, and publishes them in this repository.

## Development

```bash
pnpm install
vp run dev
```

- **CLI command**: `cove`
- **Data directory**: `~/.cove` (worktree dev state: `.cove`)
- **Default server port**: `3774`
- **URL scheme**: `covecode://` (`covecode-dev://` in development)
- **App / Bundle ID**: `net.nokiy.cove` (`net.nokiy.cove.dev` in development)

## License

[MIT](./LICENSE) — see [TRADEMARK.md](./TRADEMARK.md) for upstream trademark notice.
