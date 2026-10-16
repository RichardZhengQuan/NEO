# @neo/relay

A small, self-hostable WebSocket relay for NEO's encrypted phone tunnel. Your
phone and your NEO computer both connect out to it, so the computer needs no
public HTTP API or inbound internet port. NEO does not run a public relay yet;
the default relay URL is empty.

## Guarantees and boundaries

- The relay only forwards opaque Noise ciphertext. Pairing pins the NEO
  server's X25519 key, and bearer tokens, conversations and API requests stay
  inside the end-to-end-encrypted channel. The relay has no decryption keys.
- A fresh Ed25519 challenge signature authenticates each server registration.
  The server id is derived from that signing key; a stolen id or an earlier
  signature cannot register it. A genuine registration replaces the older one.
- Logs contain events and counts, never payloads; logged server ids are
  truncated to eight characters.
- Connection, registration, message-size, byte-rate, idle and backpressure
  limits bound resource use. A slow phone is disconnected instead of letting
  queues grow indefinitely.

The relay can see client IP addresses, server ids, connection timing and
traffic sizes. It can drop or delay traffic and is not an anonymity service.
TLS (`wss://`) protects the outer connection; Noise protects the contents even
from the relay and its TLS proxy.

## Run with Node

From a NEO source checkout, with Node.js ≥ 22.13 and pnpm:

```bash
pnpm install --frozen-lockfile
pnpm --filter @neo/protocol build
pnpm --filter @neo/tunnel build
pnpm --filter @neo/relay build
RELAY_HOST=127.0.0.1 RELAY_PORT=8787 node packages/relay/dist/main.js
```

The package's executable is `neo-relay` when installed/linked. SIGINT and
SIGTERM close all sockets and stop the HTTP listener cleanly. `GET /healthz`
returns `200 ok`; other HTTP paths return 404. WebSocket upgrades are accepted
only at `/v1/server` and `/v1/connect/<serverId>`.

## Run with Docker

The build context must be the repository root:

```bash
docker build -f packages/relay/Dockerfile -t neo-relay .
docker run -d --name neo-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -e RELAY_TRUST_PROXY=true neo-relay
```

The image runs as a non-root user and checks `/healthz`. It needs no persistent
volume: registration and connection state live in memory. The host-only port
mapping above is intended for the Caddy setup below.

## Put Caddy in front

Point a domain you control at the relay host. Replace `relay.example.com`
below with that domain; this is an example, not a NEO-operated service.

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {http.request.remote.host}
    }
}
```

Caddy handles HTTPS certificates and WebSocket upgrades. Run the relay with
`RELAY_TRUST_PROXY=true` only when clients cannot reach it directly and the
trusted proxy overwrites `X-Forwarded-For`. With that option, the relay uses
the first forwarded address for per-IP limits; otherwise it uses the socket
address. For a bare Node process behind Caddy, keep `RELAY_HOST=127.0.0.1`.

On the NEO computer, choose **Settings → Devices → Phone access → Custom
relay**, enter your `wss://` base URL and save. Alternatively set
`NEO_RELAY_URL` on the NEO server to supply its default relay. Phones try LAN
first, then the relay. The computer must stay on with NEO running.

## Environment variables

All limits are configurable. Byte limits use bytes; timing limits use
milliseconds. Connection/count/byte/timing overrides are positive integers.

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_PORT` | `8787` | HTTP/WebSocket port |
| `RELAY_TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` address |
| `RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `RELAY_PER_IP_PHONE_CONNECTIONS` | `20` | Concurrent phones per IP |
| `RELAY_PER_IP_PHONE_CONNECTIONS_PER_MINUTE` | `60` | New phone connections per IP per minute |
| `RELAY_PER_IP_SERVER_REGISTRATIONS_PER_MINUTE` | `10` | Server registrations per IP per minute |
| `RELAY_PER_SERVER_PHONE_CONNECTIONS` | `64` | Concurrent phones per server id |
| `RELAY_MAX_SERVERS` | `10000` | Registered servers globally |
| `RELAY_MAX_PHONES` | `50000` | Phone connections globally |
| `RELAY_BYTES_PER_SECOND` | `4194304` | Per-phone sustained rate, both directions combined (4 MiB/s) |
| `RELAY_BURST_BYTES` | `16777216` | Per-phone token-bucket burst capacity (16 MiB) |
| `RELAY_MAX_BUFFERED_BYTES` | `8388608` | Destination queue cap (8 MiB) |
| `RELAY_REGISTRATION_TIMEOUT_MS` | `10000` | Time to register after the challenge. Capped at `2147483647` (Node's `setTimeout` range); larger values fail startup |
| `RELAY_PHONE_IDLE_TIMEOUT_MS` | `120000` | No phone traffic in either direction. Capped at `2147483647`; larger values fail startup |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `30000` | Server ping interval; a missed pong terminates it. Capped at `2147483647`; larger values fail startup |

Noise messages are capped at 65,535 bytes; the server-side relay header adds
five bytes. Text phone messages and text messages after server registration
are protocol errors. Unknown servers close phones with 4404; replaced server
sockets close with 4409; protocol failures use 4400 and rate limits use 4429.

The TypeScript API exports `startRelay`, `RelayOptions`, `RelayLimits`,
`RelayStats` and `DEFAULT_RELAY_LIMITS`; callers can inject a logger and clock.
See [deployment documentation](../../docs/DEPLOYMENT.md#self-hosting-a-relay).
