# Cloud-mode local E2E test plan

This document is the manual gate for Phase D-1 Wave B before the orchestrator
hands the build to Phase 6's hands-on gate. It exercises the daemon's
`PASEO_CLOUD_MODE` paths against a locally-minted workspace JWT, with no
dependency on the deployed auth service.

The goal is to confirm three things, in order:

1. The daemon boots in cloud mode and rejects requests that lack a workspace
   token.
2. The WebSocket handshake completes with the `paseo.workspace.<jwt>`
   subprotocol when the token verifies against the JWKS.
3. The Claude provider materialises a per-spawn `~/.claude/` from a Secrets
   Manager-fetched credential, spawns the CLI with `HOME` pointing at it, and
   reclaims the directory on session close.

If any step fails, stop and report — do not paper over and continue.

## Prerequisites

- Docker installed locally.
- An AWS profile (`paseo-cloud-dev` or equivalent) with permission to call
  `secretsmanager:GetSecretValue` on
  `orchestra/dev/workspace/<workspace-id>/anthropic-credential`. The
  orchestrator will provision the test workspace's secret entry; for ad-hoc
  runs you can create one with `aws secretsmanager create-secret`.
- `wscat` (`npm i -g wscat`).
- A local Node 22 install and access to this repo's checkout.

## Step 1 — Generate a local JWKS fixture and signing key

The daemon validates workspace tokens against the JWKS URL given by
`ORCHESTRA_AUTH_JWKS_URL`. For local E2E we serve a fixture file via Node's
`http` module rather than pointing at the deployed auth service (which may
not exist yet when this gate runs).

```bash
mkdir -p /tmp/orchestra-jwks
node --input-type=module -e '
import { generateKeyPair, exportJWK, exportPKCS8 } from "jose";
import { writeFileSync } from "node:fs";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pubJwk = await exportJWK(publicKey);
pubJwk.kid = "orchestra-local";
pubJwk.alg = "RS256";
pubJwk.use = "sig";
writeFileSync("/tmp/orchestra-jwks/jwks.json", JSON.stringify({ keys: [pubJwk] }, null, 2));
writeFileSync("/tmp/orchestra-jwks/private.pem", await exportPKCS8(privateKey));
console.log("keypair written to /tmp/orchestra-jwks/");
'
```

Serve the JWKS over HTTP on a port the daemon container can reach. From the
host:

```bash
cd /tmp/orchestra-jwks && python3 -m http.server 7070
```

(The auth service will eventually serve this at
`http://<alb>/.well-known/orchestra-auth/jwks.json`. For local E2E we mimic
the same shape with a static file.)

## Step 2 — Build the daemon image with Wave B changes

```bash
cd /home/frank/Documents/paseo-fork
docker build -t paseo-daemon:phase-d-1-wave-b -f packages/server/Dockerfile .
```

## Step 3 — Boot the daemon in cloud mode

Run the container with `--network=host` so it can reach the local JWKS server
on `localhost:7070` and so `wscat` on the host can reach the daemon on
`:6767`:

```bash
docker run --rm \
  --network=host \
  -e PASEO_CLOUD_MODE=1 \
  -e ORCHESTRA_AUTH_JWKS_URL=http://localhost:7070/jwks.json \
  -e ORCHESTRA_STAGE=dev \
  -e AWS_PROFILE=paseo-cloud-dev \
  -v ~/.aws:/root/.aws:ro \
  paseo-daemon:phase-d-1-wave-b
```

Confirm the daemon log emits:

```
Cloud-mode workspace-token auth enabled
WebSocket server initialized on /ws  cloudMode=true
```

**Failure mode to verify:** stop the JWKS server, drop the env var, and
rerun. The daemon should refuse to boot with:

```
PASEO_CLOUD_MODE=1 requires ORCHESTRA_AUTH_JWKS_URL to be set …
```

This is the F7/F11 design-out — no silent fallback to bcrypt-Bearer.

## Step 4 — Sanity-check the HTTP path

From the host:

```bash
# /api/health bypasses auth (cloud mode preserves this).
curl -s http://localhost:6767/api/health

# Any other route requires a workspace token — expect 401.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:6767/api/status
# → 401
```

## Step 5 — Mint a workspace token and open a WS

```bash
node --input-type=module -e '
import { SignJWT, importPKCS8 } from "jose";
import { readFileSync } from "node:fs";
const pem = readFileSync("/tmp/orchestra-jwks/private.pem", "utf8");
const key = await importPKCS8(pem, "RS256");
const jwt = await new SignJWT({ account_id: "acc_local", workspace_id: "ws_local" })
  .setProtectedHeader({ alg: "RS256", kid: "orchestra-local" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(key);
console.log(jwt);
' > /tmp/orchestra-jwks/workspace.jwt
TOKEN=$(cat /tmp/orchestra-jwks/workspace.jwt)
wscat --connect ws://localhost:6767/ws --subprotocol "paseo.workspace.${TOKEN}"
```

Expected: the connection succeeds and the daemon sends a `server_info`
envelope after you send a `hello` frame.

**Failure modes to verify:**

- Pass a deliberately corrupted token (`paseo.workspace.not-a-jwt`) — the
  upgrade should be rejected with close code 4000 and reason
  `Invalid workspace token`.
- Omit the subprotocol entirely — close reason `Workspace token required`.
- Sign a JWT that's already expired — same rejection as the corrupted case;
  the daemon log should have `Rejected WebSocket connection — workspace
token failed validation`.

## Step 6 — Confirm the Claude per-spawn materialisation

Pre-seed the Anthropic credential (one-time, requires a real Anthropic key
or a recognizable placeholder — the daemon does not validate the value at
fetch time, it just hands it to the CLI):

```bash
aws secretsmanager create-secret \
  --name orchestra/dev/workspace/ws_local/anthropic-credential \
  --secret-string "sk-ant-test-placeholder-DO-NOT-USE-FOR-REAL-CALLS" \
  --region ap-southeast-2 \
  --profile paseo-cloud-dev
```

Inside the WS session from Step 5, send a `session.create_agent` (and
follow-up `start_turn`) targeting the `claude` provider. The exact wire
shape lives in `packages/server/src/shared/messages.ts`; the cleanest way to
drive this is to run `npm run web` against the cloud-mode daemon and use the
UI.

Expected log lines from inside the daemon:

```
Materialized per-spawn Claude home for cloud mode  spawnId=<hex>  homeDir=/tmp/orchestra-claude-home/<hex>
```

Verify (from inside the container, e.g. `docker exec`) that
`/tmp/orchestra-claude-home/<spawnId>/.claude/config.json` exists with
`{"primaryApiKey":"sk-ant-test-placeholder-…"}` and that the spawned `claude`
process sees `HOME` pointing there:

```bash
docker exec <container-id> sh -c '
  ls /tmp/orchestra-claude-home/
  cat /tmp/orchestra-claude-home/*/.claude/config.json
  ps auxe | grep -i claude
'
```

Close the WS connection (Ctrl-C in `wscat`). Within a few hundred
milliseconds, confirm the spawn directory has been reclaimed:

```bash
docker exec <container-id> ls /tmp/orchestra-claude-home/
# → (empty)
```

## Step 7 — Confirm on-host mode still works

This is the load-bearing regression check. Run the daemon image WITHOUT
`PASEO_CLOUD_MODE`:

```bash
docker run --rm \
  --network=host \
  paseo-daemon:phase-d-1-wave-b
```

Confirm:

- `Cloud-mode workspace-token auth enabled` does NOT appear.
- The daemon log says `WebSocket server initialized on /ws  cloudMode=false`.
- `wscat` connects on the legacy `paseo.bearer.<password>` subprotocol when
  a password is configured (or unauthenticated when it isn't).
- No `/tmp/orchestra-claude-home/` directories are created when a Claude
  agent is spawned — the on-host path uses the operator's real `~/.claude/`.

If any of (1)–(7) fail or behave unexpectedly, report exactly which step
diverged and what the daemon logged. Do not patch the test plan to make a
failure pass.
