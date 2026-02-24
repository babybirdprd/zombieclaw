# Pi Core + ZeroClaw Compatibility Migration

## Purpose
This project now treats `pi_agent_rust` as the canonical runtime core and uses `zeroclaw` as the compatibility gateway/control-ui layer in places where we keep legacy app contracts.

## Vendored Upstream References
Snapshot command set used for this migration:

```bash
mkdir -p references/upstream
bunx degit Dicklesworthstone/pi_agent_rust references/upstream/pi_agent_rust
bunx degit zeroclaw-labs/zeroclaw references/upstream/zeroclaw
```

Pinned upstream commit SHAs:

- `pi_agent_rust`: `2f0b74135957a4a8b5ba57746566793fd6fe9896`
- `zeroclaw`: `aa45c30ed6b92e17ab6e7869bf65145b79bb7ac8`

## Runtime Contract Kept Stable
- Compatibility gateway port: `18789`
- Compatibility control UI port: `19001`
- AnyClaw web server port: `18923`

## Android Startup Changes
- Replaced OpenClaw install/config/start flow with:
  - `installPiCore()`
  - `installZeroClawCompat()`
  - `startPiGatewayCompat()`
  - `startPiControlUiServer()`
- Codex login/proxy/server flow remains intact.

## Web App Changes
- Replaced the old sidebar OpenClaw external link with an in-app App Drawer.
- Added route-driven switch between:
  - Codex app surface
  - Pi compatibility surface
- Added `/pi-api/*` bridge endpoints with strict pairing + bearer-token auth for Pi runtime control.

## Implemented Pi Bridge Contract

The Node server now manages `pi --mode rpc` directly and maps HTTP endpoints to Pi JSON-lines RPC.

Auth and pairing:
- `GET /pi-api/auth/status`
- `POST /pi-api/pair` (accepts JSON `{ "code": "123456" }` or `X-Pairing-Code`)

Runtime:
- `GET /pi-api/health`
- `GET /pi-api/events` (SSE, auth-protected when pairing enabled)
- `GET /pi-api/state`
- `GET /pi-api/messages`
- `GET /pi-api/models`
- `POST /pi-api/model`
- `POST /pi-api/prompt`
- `POST /pi-api/abort`
- `POST /pi-api/session/new`
- `POST /pi-api/session/switch`
- `POST /pi-api/session/name`
- `POST /pi-api/rpc` (generic adapter)
- `POST /pi-api/webhook` (ZeroClaw-compatible message prompt shim)

## Android/Linux Startup Hardening
- `startPiGatewayCompat()` now verifies that `127.0.0.1:18789` is actually reachable before reporting success.
- `startPiControlUiServer()` now verifies that `127.0.0.1:19001` is reachable before reporting success.

## Rollback Note
If a deployment must temporarily return to the previous OpenClaw path, restore the old `MainActivity` setup steps and corresponding `CodexServerManager` method calls. Keep this document updated when changing migration direction.
