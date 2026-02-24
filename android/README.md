# ZombieClaw (Android)

Android APK that embeds a Termux-style Linux bootstrap environment, installs pi_agent_rust + zeroclaw compatibility + Codex on first run, and presents the ZombieClaw UI inside a WebView.

## Architecture

```
┌─────────────────────────────────────────┐
│              Android APK                │
│                                         │
│  ┌──────────────┐  ┌────────────────┐   │
│  │   WebView    │  │  Bootstrap     │   │
│  │              │  │  Installer     │   │
│  │ localhost:   │  │                │   │
│  │   18923      │  │  Extracts      │   │
│  │              │  │  Termux env    │   │
│  └──────┬───────┘  └───────┬────────┘   │
│         │                  │            │
│         ▼                  ▼            │
│  ┌──────────────────────────────────┐   │
│  │    /data/data/com.codex.mobile/  │   │
│  │    files/usr/  (Termux prefix)   │   │
│  │                                  │   │
│  │    ├── bin/node                   │   │
│  │    ├── bin/codex                  │   │
│  │    └── lib/node_modules/         │   │
│  │        └── codex-web-local/      │   │
│  │            ├── dist/      (Vue)  │   │
│  │            └── dist-cli/  (srv)  │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Prerequisites

- Android Studio (or just the Android SDK command-line tools)
- Java 17+
- curl (for downloading bootstrap)

## Build Instructions

### 1. Download the Termux bootstrap

```bash
cd android
./scripts/download-bootstrap.sh
```

This downloads `bootstrap-aarch64.zip` (~30 MB) from Termux releases into `app/src/main/assets/`.

### 2. (Optional) Bundle the server

If you want to pre-bundle the codex-web-local server in the APK so users don't need to `npm install` it on first run:

```bash
./scripts/build-server-bundle.sh
```

This builds the Vue frontend + Express CLI from the parent project and copies them into `app/src/main/assets/server-bundle/`.

### 3. Build the APK

```bash
./gradlew assembleDebug
```

The APK will be at `app/build/outputs/apk/debug/app-debug.apk`.

For a release build:

```bash
./gradlew assembleRelease
```

## First Run

On first launch, the app will:

1. Extract the bootstrap environment (~30 MB compressed, ~100 MB extracted)
2. Run `apt-get install nodejs-lts` (downloads ~30 MB)
3. Install Codex CLI + codex-web-local
4. Install Pi core (`pi_agent_rust`) and zeroclaw compatibility runtime
5. Prompt for your OpenAI login/API key as needed
6. Start the server and load the WebView with app-drawer routing

Steps 1-4 only happen once. Subsequent launches skip straight to authentication + app startup.

## Minimum Requirements

- Android 7.0 (API 24) or higher
- arm64-v8a device (most modern Android phones)
- ~500 MB free storage for bootstrap + Node.js + Codex
- Internet connection (for API calls and first-run package installs)
