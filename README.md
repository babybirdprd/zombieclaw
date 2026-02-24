<div align="center">

# ZombieClaw

### Pi Agent Rust + Codex — Running Natively on Android

[![Android](https://img.shields.io/badge/Android-7.0+-3DDC84?logo=android&logoColor=white&style=for-the-badge)](https://developer.android.com)
[![Pi Core](https://img.shields.io/badge/Pi_Agent_Rust-Core-FF6A00?style=for-the-badge)](https://github.com/Dicklesworthstone/pi_agent_rust)
[![ZeroClaw](https://img.shields.io/badge/ZeroClaw-Compat-0EA5E9?style=for-the-badge)](https://github.com/zeroclaw-labs/zeroclaw)
[![Codex](https://img.shields.io/badge/Codex_CLI-0.104.0-412991?logo=openai&logoColor=white&style=for-the-badge)](https://github.com/openai/codex)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white&style=for-the-badge)](https://nodejs.org)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.1-7F52FF?logo=kotlin&logoColor=white&style=for-the-badge)](https://kotlinlang.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

<br />

> **A self-contained Android APK that bundles Pi Agent Rust + OpenAI Codex CLI**
> **with a complete Linux environment. Two AI agents, one app, your pocket.**

<br />

[Download APK](https://github.com/babybirdprd/zombieclaw/releases/latest) ·
[Migration Plan](documentation/MIGRATION_PI_ZEROCLAW.md) ·
[Project Spec](PROJECT_SPEC.md)

<br />

<img src="screenshots/screenshot.png" width="280" alt="ZeroClaw Mobile UI" /> &nbsp;&nbsp; <img src="screenshots/screenshot2.png" width="280" alt="Codex Coding Agent" />

</div>

---

## What Is This?

This project puts two AI coding runtimes on your Android phone in a single APK:

- **[pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust)** — canonical local core runtime
- **[OpenAI Codex CLI](https://github.com/openai/codex)** — terminal coding agent + app-server protocol backend
- **[zeroclaw](https://github.com/zeroclaw-labs/zeroclaw)** — compatibility gateway/control-ui layer aligned with the Pi core direction

Both run inside an embedded Linux environment extracted from the APK. No root required. No Termux dependency. Everything is self-contained.

The app authenticates once via OpenAI OAuth. Codex uses `codex app-server`, while the Pi lane is exposed through a compatibility gateway and in-app drawer routing.

---

## What Can You Do?

| | Feature | Description |
|---|---|---|
| | **App Drawer** | In-app switching between ZeroClaw and Codex surfaces (single WebView shell) |
| | **ZeroClaw Surface** | Mobile-first ZeroClaw web UI backed by Pi core compatibility endpoints |
| | **Codex Chat** | Conversational coding agent with streaming responses and reasoning visibility |
| | **Execute Commands** | Both agents run shell commands in the embedded Linux environment |
| | **Multi-Thread Sessions** | Parallel conversations, each with its own context and working directory |
| | **Full Auto-Approval** | No permission popups — `danger-full-access` mode by default |
| | **Background Execution** | Foreground service keeps everything alive when you switch apps |
| | **OAuth Login** | One-time browser-based OpenAI auth — shared between both agents |
| | **Offline Bootstrap** | Linux environment extracted from APK — works without internet after setup |

---

## Quick Start

```bash
git clone https://github.com/babybirdprd/zombieclaw.git
cd zombieclaw

npm install && npm run build

cd android && bash scripts/download-bootstrap.sh
bash scripts/build-server-bundle.sh && ./gradlew assembleDebug

adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.codex.mobile/.MainActivity
```

Or [download the latest APK](https://github.com/babybirdprd/zombieclaw/releases/latest) directly.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Android APK                          │
│                                                           │
│  ┌────────────┐  ┌──────────────────────────────────────┐ │
│  │  WebView   │  │  APK Assets                          │ │
│  │  (Vue.js)  │  │  bootstrap-aarch64.zip               │ │
│  └─────┬──────┘  │  server-bundle/ (Vue + Express)      │ │
│        │         │  proxy.js / bionic-compat.js          │ │
│        │         └──────────────────────────────────────┘ │
│  ┌─────▼────────────────────────────────────────────────┐ │
│  │             CodexServerManager                        │ │
│  │  Bootstrap → Node.js → Codex + Pi Runtime → Auth      │ │
│  │  Proxy → Gateway → Control UI → Web Server            │ │
│  └─────┬────────────────────────────────────────────────┘ │
│        │                                                  │
│  ┌─────▼────────────────────────────────────────────────┐ │
│  │             Embedded Linux ($PREFIX)                   │ │
│  │                                                       │ │
│  │  codex-web-local   → :18923 (HTTP, WebView target)    │ │
│  │    └─ codex app-server (native Rust/musl, JSON-RPC)   │ │
│  │                                                       │ │
│  │  pi compat gateway → :18789 (WebSocket)               │ │
│  │  pi control UI     → :19001 (static file server)      │ │
│  │                                                       │ │
│  │  proxy.js          → :18924 (CONNECT proxy, DNS/TLS)  │ │
│  └───────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Services

| Port | Service | Purpose |
|------|---------|---------|
| 18789 | Pi Compat Gateway | WebSocket compatibility control plane |
| 18923 | ZombieClaw app server | HTTP server with dual app shell (`/apps/zeroclaw` + `/apps/codex`) |
| 18924 | CONNECT Proxy | DNS/TLS bridge for musl-linked Codex binary |

---

## Pi Core + ZeroClaw Compatibility

ZombieClaw installs:

1. `pi_agent_rust` as the runtime core
2. `zeroclaw` as compatibility/runtime helper binary
3. a mobile-first ZeroClaw web UI served at `/apps/zeroclaw`
4. Codex UI served at `/apps/codex`

Both surfaces are available through the in-app App Drawer.

---

## How It Works

### Embedded Linux

The APK bundles Termux's `bootstrap-aarch64.zip` — a minimal Linux userland with `sh`, `apt-get`, `dpkg-deb`, SSL certificates, and core libraries. On first launch, it's extracted to the app's private storage at `$PREFIX = /data/user/0/com.codex.mobile/files/usr`.

### Native Codex Binary

The Codex CLI ships a 73MB native Rust binary compiled for `aarch64-unknown-linux-musl`. npm refuses to install it on Android, so we download the tarball directly from the npm registry and extract it manually.

### DNS/TLS Proxy

The musl-linked binary reads `/etc/resolv.conf` for DNS — which doesn't exist on Android. A Node.js CONNECT proxy on port 18924 bridges this: Node.js uses Android's Bionic DNS resolver, and the native binary routes all HTTPS through `HTTPS_PROXY`.

### W^X Bypass

Android 10+ enforces SELinux W^X (Write XOR Execute) policies. We use `targetSdk = 28` to bypass this, same approach as Termux (F-Droid).

---

## Startup Sequence

1. Battery optimization exemption + foreground service
2. Bootstrap extraction (Termux userland)
3. proot installation (package management)
4. Node.js installation (`apt-get download` + `dpkg-deb`)
5. Python installation
6. `bionic-compat.js` extraction
7. pi_agent_rust + zeroclaw compatibility install
8. Codex CLI + native platform binary installation
9. Full-access config (`approval_policy = "never"`)
10. CONNECT proxy startup
11. OAuth login (`codex login` via browser)
12. Health check (`codex exec "say hi"`)
13. Pi compatibility gateway startup
14. ZombieClaw app server startup
15. WebView loads `http://127.0.0.1:18923/apps/zeroclaw`

---

## Project Structure

```
android/
├── app/src/main/
│   ├── AndroidManifest.xml
│   ├── assets/
│   │   ├── proxy.js                 # CONNECT proxy (DNS/TLS bridge)
│   │   ├── bionic-compat.js         # Android platform shim
│   │   └── server-bundle/           # Pre-built Vue + Express + deps
│   └── java/com/codex/mobile/
│       ├── BootstrapInstaller.kt    # Linux environment setup
│       ├── CodexForegroundService.kt # Background persistence
│       ├── CodexServerManager.kt    # Install, auth, proxy, pi/zeroclaw runtime, server
│       └── MainActivity.kt         # WebView + setup orchestration
├── scripts/
│   ├── download-bootstrap.sh        # Fetch Termux bootstrap
│   └── build-server-bundle.sh       # Bundle frontend into APK assets
src/                                  # codex-web-local (TypeScript + Vue)
├── api/                              # RPC client, gateway, SSE
├── components/                       # Vue components (composer, threads, sidebar)
├── composables/                      # useDesktopState (reactive state)
├── server/                           # Express + codex app-server bridge
└── cli/                              # CLI entry point
```

---

## Requirements

- **Android 7.0+** (API 24) — ARM64 device
- **Internet connection** — for first-run setup + API calls
- **OpenAI account** — authenticated via OAuth browser flow
- **~500MB storage** — for Linux environment + Node.js + Codex + pi/zeroclaw runtime + build tools

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| AI Gateway | ZeroClaw compat layer | current |
| AI Agent | OpenAI Codex CLI | 0.104.0 |
| Model | gpt-5.3-codex (via Codex OAuth) | - |
| Runtime | Node.js (via Termux) | 24.13.0 |
| Build Tools | Clang/LLVM, CMake, Make, LLD | 21.1.8 / 4.2.3 |
| Frontend | Vue.js 3 + Vite + TailwindCSS | 3.x |
| Backend | Express.js + JSON-RPC bridge | - |
| Android | Kotlin + WebView | 2.1.0 |
| Linux | Termux bootstrap (aarch64) | - |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| App crashes on launch | Check `adb logcat \| grep CodexServerManager` |
| "Permission denied" executing binaries | Ensure `targetSdk = 28` in `build.gradle.kts` |
| ZeroClaw compat gateway fails to start | Check runtime install logs and `zeroclaw` binary availability |
| koffi build fails | Verify clang/cmake/make are installed and binary-patched |
| "No address associated with hostname" | Check internet; CONNECT proxy may not be running |
| Login page doesn't open | Ensure a default browser is set on the device |
| App killed in background | Grant battery optimization exemption in Android settings |

---

## Credits

- [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) — Rust runtime and web UI reference
- [OpenAI Codex CLI](https://github.com/openai/codex) — Terminal-based coding agent
- [AidanPark/openclaw-android](https://github.com/AidanPark/openclaw-android) — Android bootstrap compatibility references
- [Termux](https://termux.dev) — Linux environment bootstrap for Android

---

<div align="center">

**Two AI agents. One APK. Your pocket.**

[Download APK](https://github.com/babybirdprd/zombieclaw/releases/latest) · [ZeroClaw Upstream](https://github.com/zeroclaw-labs/zeroclaw) · [Project Spec](PROJECT_SPEC.md)

</div>
