# Paseo App

Cross-platform client for Paseo — runs on iOS, Android, web (browser), and web (Electron desktop).

## Development

```bash
# From repo root
npm run dev            # Starts daemon + Expo in Tmux

# Or app-only
cd packages/app
npx expo start         # Dev server for all platforms
npx expo start --web   # Web only
```

## Web build

```bash
npm run build:web      # Output in dist/
```

## Environment variables

| Variable                              | Purpose                                          | Default                                                             |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `EXPO_PUBLIC_ORCHESTRA_AUTH_URL`      | Orchestra auth service base URL                  | `http://orchestra-dev-1104346820.ap-southeast-2.elb.amazonaws.com`  |
| `EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL` | Orchestra daemon WebSocket URL                   | `ws://orchestra-dev-1104346820.ap-southeast-2.elb.amazonaws.com/ws` |
| `EXPO_PUBLIC_ENABLE_AUDIO_DEBUG`      | Set to `1` to render the in-app audio debug card | (unset)                                                             |

## Orchestra cloud mode (D-1)

The web client can connect to Orchestra — a cloud-hosted daemon that provisions workspaces, clones repos, and runs agents remotely.

### Known limitation: mixed content

At D-1, the Orchestra auth service and daemon run behind an HTTP-only ALB. Cloudflare Pages serves the app over HTTPS. Browsers block mixed content (HTTPS page making HTTP requests / opening WS connections to an HTTP origin), so the deployed Pages build **cannot reach the D-1 ALB**.

Workarounds for local testing:

- Run the web client locally via `npx expo start --web` (served over HTTP)
- Use `EXPO_PUBLIC_ORCHESTRA_AUTH_URL` / `EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL` to point at the ALB

This limitation is resolved in D-2 when the ALB gets TLS termination.

## Cloudflare Pages deployment

The `wrangler.toml` in this directory configures the `orchestra-app` Pages project. Build output is `dist/` from `npm run build:web`.

```bash
npx wrangler pages deploy dist/
```
