# NEO Deployment Guide

NEO supports three deployment topologies:

| Topology | Who it's for |
|---|---|
| **On-device** | One person; everything runs inside the desktop app. |
| **Self-hosted** | Household, team, or power user; run the server on your own hardware or VPS. |
| **Self-hosted + Docker** | Same, but containerised for easy upgrades and isolation. |

---

## 1. On-device (desktop app)

The **NEO desktop app** embeds the server.  No separate installation is needed.

1. Go to this repository's [GitHub Releases](https://github.com/RichardZhengQuan/NEO/releases)
   and download `NEO-<version>-arm64.dmg` (Apple Silicon) or
   `NEO-<version>-x64.dmg` (Intel) for the latest Mac release.
2. Open the dmg and drag `NEO.app` into **Applications**.
3. On first launch, right-click `NEO.app` in **Applications** → **Open** →
   **Open** in the Gatekeeper dialog. This is required because the app is not
   yet signed; subsequent launches don't need it. Alternatively, run this in
   Terminal before launching:

   ```bash
   xattr -dr com.apple.quarantine /Applications/NEO.app
   ```

4. The app starts an embedded server on a random localhost port and opens
   the web UI in a native window. The onboarding wizard then guides you
   through adding an AI provider and configuring memory settings.

Packaged Windows and Linux builds are planned but not shipped yet; macOS is the only platform on the Releases page today.

Data is stored in the platform userData directory:

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/NEO/data/` |
| Windows | `%APPDATA%\NEO\data\` |
| Linux | `~/.config/NEO/data/` |

You can also run the server on your laptop without the Electron shell:

```bash
# Build from source (NEO isn't published to npm yet)
pnpm install && pnpm build

node packages/cli/dist/index.js serve      # or link it once: (cd packages/cli && pnpm link --global) && neo serve
# Open http://127.0.0.1:7777 in your browser.
```

### Desktop icons

The desktop app uses the unchanged girl portrait from
`packages/ui/assets/avatar-art/girl.webp`, fitted inside a rounded tile with
64/1024 transparent padding. Website and mobile icons are independent.

Run `pnpm --filter @neo/desktop icon:generate` to regenerate the ICNS, ICO and
seven Linux PNG files under `apps/desktop/build/`. The existing resvg/png2icons
toolchain needs no Electron binary or platform-specific image converter.

`apps/desktop/build/source-girl.png` is a lossless format bridge because the
bundled resvg 2.6.2 does not decode WebP. If the canonical portrait changes,
refresh that bridge once with an image decoder, preserving every decoded RGBA
pixel and the original dimensions. The initial conversion used Python/Pillow:

```python
from PIL import Image
source = Image.open("packages/ui/assets/avatar-art/girl.webp").convert("RGBA")
source.save("apps/desktop/build/source-girl.png", format="PNG", optimize=False, compress_level=9)
assert Image.open("apps/desktop/build/source-girl.png").convert("RGBA").tobytes() == source.tobytes()
```

Pillow is an asset-maintenance tool, not a project or CI dependency; normal icon
regeneration reads the checked-in PNG. Do not crop, redraw or replace the
canonical artwork while refreshing it.

### Updates

The desktop app checks this repository's GitHub Releases for updates on launch
in packaged builds only. Development builds skip the automatic check.
Pre-release GitHub Releases are skipped by default (`allowPrerelease` is `false`).

When a newer release is available, NEO downloads it in the background and
shows a system notification when the download is ready. The update installs
when NEO next quits.

**Help → Check for updates…** triggers a manual check and shows the result
in a dialog: `Downloading NEO <version>…`, `NEO is up to date.`, or an error
(`Could not check for updates: <detail>`).

There is currently no user-facing toggle to disable the auto-updater.

---

## 2. Self-hosted — Docker Compose (recommended)

### Quick start

```bash
git clone https://github.com/your-org/neo.git
cd neo

# Optional: copy the example env file and add API keys.
cp .env.example .env   # edit ANTHROPIC_API_KEY etc.

docker compose up -d

# NEO is now running at http://localhost:7777
```

### With automatic HTTPS (Caddy)

1. Point a domain at your server.
2. Edit `deploy/Caddyfile` — replace `neo.example.com` with your domain.
3. Set `NEO_PUBLIC_URL` in `docker-compose.yml` to your public URL.

```bash
docker compose --profile tls up -d
```

Caddy obtains and renews a Let's Encrypt certificate automatically.

The Compose API port is published on `127.0.0.1:7777` by default, including
with the TLS profile. Caddy reaches `neo:7777` over the Compose network;
remote clients use Caddy's HTTPS endpoint. For intentional LAN access, replace
the port mapping with the commented `7777:7777` alternative in
`docker-compose.yml`. That exposes plaintext HTTP on every host interface.

### With local AI (Ollama)

```bash
docker compose --profile local-ai up -d

# Pull a model (first time only):
docker compose exec ollama ollama pull llama3.2

# In NEO Settings → Providers, add an Ollama provider pointing at:
# http://ollama:11434
```

### Upgrades

```bash
docker compose pull
docker compose up -d --remove-orphans
```

Data persists in the `neo_data` Docker volume across upgrades.

The image runs the deployed CLI at `/app/dist/index.js` with its production
dependencies in `/app/node_modules`. The web build stays at
`/app/apps/web/dist` (`NEO_WEB_DIR`); the fresh `/data` volume is owned by the
non-root `neo` user. Compose uses these same paths.

---

## 3. Self-hosted — Bare Node + systemd

### Prerequisites

- Node.js ≥ 22.13
- A `neo` system user: `sudo useradd --system neo`
- A data directory: `sudo install -d -o neo -g neo -m 700 /var/lib/neo`

### Installation

```bash
# Clone and build
git clone https://github.com/your-org/neo.git /opt/neo
cd /opt/neo
pnpm install --frozen-lockfile
pnpm build

# Install the systemd unit
sudo cp deploy/neo.service /etc/systemd/system/neo.service
# Edit paths in the unit file if needed:
sudo systemctl daemon-reload
sudo systemctl enable --now neo

# Check it started:
systemctl status neo
journalctl -fu neo
```

### nginx reverse proxy

```nginx
# /etc/nginx/sites-available/neo
server {
    listen 443 ssl http2;
    server_name neo.example.com;

    ssl_certificate     /etc/letsencrypt/live/neo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/neo.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:7777;
        proxy_http_version 1.1;

        # WebSocket support (required)
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host             $host;
        proxy_set_header   X-Real-IP        $remote_addr;
        proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400s;  # keep WebSocket connections open
    }
}
```

### Caddy without Docker

```
# /etc/caddy/Caddyfile
neo.example.com {
    reverse_proxy 127.0.0.1:7777
}
```

---

## 4. Configuration reference

NEO is configured in three layers (later layers win):

1. `<dataDir>/config.json` — persistent file
2. `NEO_*` environment variables
3. CLI flags / `--config` overrides

### config.json fields

```jsonc
{
  // "local" (on-device) or "server" (self-hosted)
  "mode": "server",

  // Where the database and key files live. ~ is expanded.
  "dataDir": "~/.neo",

  "server": {
    "host": "0.0.0.0",       // bind address
    "port": 7777,
    // Public URL for pairing links and Web Push click targets.
    // Required when behind a reverse proxy.
    "publicUrl": "https://neo.example.com",
    "authToken": "",          // owner token (generated at first boot if empty)
    "webDir": null,           // path to the built web app (served at /)
    "trustProxy": false,      // enable only when reachable solely through a trusted proxy
    "corsOrigins": [],        // extra CORS origins
    "maxBodyBytes": 20971520  // 20 MB
  },

  // Separate encrypted LAN listener; starts only while phone access is enabled.
  "tunnel": {
    "lan": true,
    "host": "0.0.0.0",
    "port": 7778,
    "advertise": [],          // explicit host:port addresses (for Docker/NAT)
    "relayUrl": ""            // optional relay default; no NEO public relay exists yet
  },

  // Boot-time provider list (empty by default). Connect an AI in Settings → AI.
  // Providers added via the UI are stored in the DB.
  "providers": [],

  // Web search (optional)
  "webSearch": {
    "provider": "none",        // "none" | "searxng" | "brave" | "tavily"
    "baseUrl": "",
    "apiKey": ""
  },

  // Web Push VAPID keys (auto-generated at first boot into <dataDir>/vapid.json)
  "push": {
    "vapidPublicKey": "",
    "vapidPrivateKey": "",
    "subject": "mailto:neo@localhost",
    "allowedHosts": []        // optional extra trusted Web Push hostnames, e.g. "push.example.com"
  },

  // Plugin directory
  "plugins": {
    "enabled": false,
    "dir": ""
  },

  "log": {
    "level": "info"  // "debug" | "info" | "warn" | "error" | "silent"
  }
}
```

### Environment variables

| Variable | Equivalent config field |
|---|---|
| `NEO_MODE` | `mode` |
| `NEO_DATA_DIR` | `dataDir` |
| `NEO_HOST` | `server.host` |
| `NEO_PORT` | `server.port` |
| `NEO_TOKEN` | `server.authToken` |
| `NEO_PUBLIC_URL` | `server.publicUrl` |
| `NEO_WEB_DIR` | `server.webDir` |
| `NEO_TRUST_PROXY` | `server.trustProxy` (`true`/`false`, also `1`/`0`) |
| `NEO_LOG_LEVEL` | `log.level` |
| `NEO_TUNNEL_LAN` | `tunnel.lan` (strict `true`/`false`/`1`/`0`) |
| `NEO_TUNNEL_HOST` | `tunnel.host` (default `0.0.0.0`) |
| `NEO_TUNNEL_PORT` | `tunnel.port` (default 7778; 0 chooses an available port) |
| `NEO_TUNNEL_ADVERTISE` | `tunnel.advertise` (comma-separated validated `host:port` addresses) |
| `NEO_RELAY_URL` | `tunnel.relayUrl` (default empty; supply your own relay's ws(s) base URL) |

Proxy headers are ignored by default. Enable `NEO_TRUST_PROXY=true` or
`server.trustProxy: true` only when clients cannot reach NEO directly and your
proxy replaces forwarded IP headers. NEO then uses the first `X-Forwarded-For`
address, falling back to `X-Real-IP`, for both HTTP and WebSocket auth failure
limits. Configure a single-edge nginx proxy with
`proxy_set_header X-Forwarded-For $remote_addr;` to overwrite caller-supplied
values. Valid tokens continue to authenticate even when anonymous failures
exhaust an IP's bucket. WebSockets accept at most 64 KiB per message and five
concurrent unauthenticated sockets per client IP.

Web Push endpoints must use HTTPS on the supported Google, Mozilla, Apple or
Windows push services. Other Google API hosts must use a push path (`gcm`,
`fcm`, `wp`, `wpush` or `push`). Subscription and delivery both validate the
endpoint. `push.allowedHosts` adds explicitly trusted hostnames, optionally
with a `*.` subdomain prefix, for other push services. An added host can receive
notification contents and server requests; keep the list limited to push
infrastructure you trust. URLs, credentials and nonstandard ports are rejected.

Provider credential headers (names containing `auth`, `key`, `token` or
`secret`, and cookies) are encrypted in the SecretStore, resolved for adapters,
and redacted in API responses. Existing plaintext database header configs are
migrated when loaded. Config-file credentials remain in the file you supply;
protect that file alongside your data directory.

### Provider API key variables

These variables add or update providers in the boot config.  They are the
easiest way to configure providers without editing files:

| Variable | Provider added/updated |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (`claude-3-5-sonnet-latest` default) |
| `OPENAI_API_KEY` | OpenAI (`gpt-4o` default) |
| `GEMINI_API_KEY` | Google Gemini (`gemini-2.0-flash` default) |
| `OLLAMA_BASE_URL` | Ollama (e.g. `http://localhost:11434`) |

---

## 5. Pairing phones and other devices

Every device (browser, phone, CLI) needs a **device token**.  The owner token
created at first boot is the most-privileged token.

Server startup prints pairing instructions without the owner credential.
Captured local startup output is also credential-free. `neo serve --show-token`
explicitly enables credential output; an interactive local terminal may show
it automatically. Treat any output captured with that option as secret.

**From the web UI:**

1. Open **Settings → Devices → Pair a phone**.
2. A one-time QR code and pairing link appear (valid for five minutes).
3. Scan with your phone; it receives its own revocable token.

For on-device servers, pairing turns on **Phone access** automatically. You
can also use the owner-only switch in Devices. Phones on the same network
connect to the encrypted listener on **7778/TCP** by default, independently of
the desktop window's loopback HTTP port. macOS or Windows may show a firewall
prompt the first time phone access is turned on; allow local-network access.
The computer must stay on and NEO must keep running. Keep it in the menu bar /
tray and enable opening at login. Turning phone access off closes active LAN
and relay tunnels. The LAN listener returns 404 for plaintext HTTP, including `/api/*`.

If 7778 is occupied, NEO logs a warning and uses an available port; new QR codes
carry that actual port. Existing phones may need a fresh pairing link after an
address or port change. Phones try the LAN route first and fall back to a
configured relay when it is unreachable. For away-from-home access, see
[self-hosting a relay](#self-hosting-a-relay).

For Docker, publish the tunnel port separately (for example `7778:7778`) and
set `NEO_TUNNEL_ADVERTISE=192.168.1.20:7778` to the host's reachable address when
container addresses differ from the host. Explicit advertisements retain their
configured ports, so match any published-port mapping. Restrict this port to
the local network; it serves only the encrypted tunnel.

**On mobile:**

Open the NEO mobile app → Connect screen → scan the QR code or paste the link.

**On the CLI:**

```bash
neo pair --url https://neo.example.com
# Creates a new device token and prints its pairing link/QR.
```

**Revoke a device** from Settings → Devices → select the device → Revoke.
Revocation immediately closes its authenticated WebSockets (code 4401), removes
its push subscriptions, and prevents further authentication and push delivery.

To rotate the owner token, stop NEO, delete `<dataDir>/token`, and restart.
Alternatively set a new `NEO_TOKEN` (or `server.authToken`) and restart. An
explicit configured token takes precedence over the token file, so remove or
change it when using the deletion method. Rotation atomically invalidates all
previous owner credentials. Paired device tokens keep working; they do not
need to re-pair. Keep an environment override in place until you intentionally
change it again: the existing token file is not overwritten by `NEO_TOKEN`.

---

## Self-hosting a relay

NEO does not run a public relay yet. The default `tunnel.relayUrl` is `''`;
away-from-home access requires a relay you host or another relay you choose.
The relay is separate from your NEO server and stores no conversations or
keys. Both the phone and the NEO computer make outbound WebSocket connections
to it, so the computer needs no public API or inbound internet port.

### Docker

Build from the repository root. This image includes only `@neo/protocol`,
`@neo/tunnel` and `@neo/relay`, and runs as a non-root user:

```bash
docker build -f packages/relay/Dockerfile -t neo-relay .
docker run -d --name neo-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -e RELAY_TRUST_PROXY=true neo-relay
```

Use the Caddy setup below for public access. The host-only port mapping
prevents clients from bypassing that proxy. The image has a `/healthz` health
check; the relay needs no persistent volume. Restarting it disconnects current
phones; NEO reconnects automatically.

### Node

Requirements are Node.js ≥ 22.13 and pnpm. From the source checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @neo/protocol build
pnpm --filter @neo/tunnel build
pnpm --filter @neo/relay build
RELAY_HOST=127.0.0.1 RELAY_PORT=8787 RELAY_TRUST_PROXY=true \
  node packages/relay/dist/main.js
```

The package also declares the `neo-relay` executable. SIGINT and SIGTERM shut
down the listener and all sockets cleanly. `GET /healthz` returns `200 ok`;
other HTTP paths return 404.

### Secure WebSocket access with Caddy

Point a domain you control at the relay host and replace `relay.example.com`
in this Caddyfile with it. This is an example domain, not a NEO public relay:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {http.request.remote.host}
    }
}
```

Caddy handles TLS certificates and WebSocket upgrades, making your relay base
URL `wss://` followed by your domain. Set `RELAY_TRUST_PROXY=true` only behind
a trusted proxy that overwrites `X-Forwarded-For`, and block direct public
access to the relay's port. The relay then uses the first forwarded address
for per-IP limits. With proxy trust off, it uses the socket address.

### Point NEO at your relay

On the NEO computer, open **Settings → Devices → Phone access → Custom
relay**, enter your secure `wss://` base URL and save. Custom URLs cannot
contain credentials, query parameters or fragments. Enable Phone access.
The **Away from home** status reports connecting, connected or an error.
Selecting **No relay (same network only)** disables relay access. **Default
relay** uses the server's configured default and is unavailable when it is
empty; NEO honestly shows that no public relay is available yet.

For a self-hosted NEO server, set `NEO_RELAY_URL` to your relay's base URL (or
`tunnel.relayUrl` in its config) to provide a default. A saved custom URL
overrides that default; selecting Default relay resets the override to null.
The relay process uses `RELAY_*` variables, while the NEO server uses
`NEO_RELAY_URL`. Phones receive the relay URL in their pinned pairing route,
try LAN first and then the relay, and can claim a pairing code through either
path. The configured URL remains advertised during relay reconnection. The
computer must stay on with NEO running for either path to work.

### What the relay can and cannot see

The phone pins the computer's static X25519 key from the pairing QR and uses
Noise NK end-to-end encryption. The relay forwards opaque bytes and has no
decryption keys: it cannot read conversations, pairing codes, API requests or
device tokens. Each server registration proves its Ed25519 signing key by
signing a fresh challenge; the server id is derived from that key, preventing
an attacker from claiming a stolen id or replaying an earlier signature.

The relay can see IP addresses, server ids, connection timing and traffic
sizes, and it can drop or delay traffic. TLS protects the outer connection;
it does not hide this metadata from the relay. Payloads are never logged.
Logs contain events and counts, with server ids truncated to eight characters.

### Relay environment and limits

The defaults below apply to `neo-relay`, not the NEO server. Count, byte and
timing overrides are positive integers; byte limits are in bytes and timing
limits in milliseconds.

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for bare Node behind Caddy |
| `RELAY_PORT` | `8787` | HTTP/WebSocket port |
| `RELAY_TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` address |
| `RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `RELAY_PER_IP_PHONE_CONNECTIONS` | `20` | Concurrent phones per IP |
| `RELAY_PER_IP_PHONE_CONNECTIONS_PER_MINUTE` | `60` | New phones per IP per minute |
| `RELAY_PER_IP_SERVER_REGISTRATIONS_PER_MINUTE` | `10` | Server registrations per IP per minute |
| `RELAY_PER_SERVER_PHONE_CONNECTIONS` | `64` | Concurrent phones per server id |
| `RELAY_MAX_SERVERS` | `10000` | Registered servers globally |
| `RELAY_MAX_PHONES` | `50000` | Phone connections globally |
| `RELAY_BYTES_PER_SECOND` | `4194304` | Combined per-phone sustained traffic in both directions (4 MiB/s) |
| `RELAY_BURST_BYTES` | `16777216` | Per-phone token-bucket burst (16 MiB) |
| `RELAY_MAX_BUFFERED_BYTES` | `8388608` | Destination queue cap (8 MiB) |
| `RELAY_REGISTRATION_TIMEOUT_MS` | `10000` | Time to answer the registration challenge. Capped at `2147483647` (Node's `setTimeout` range); larger values fail startup |
| `RELAY_PHONE_IDLE_TIMEOUT_MS` | `120000` | Maximum inactivity in both directions. Capped at `2147483647`; larger values fail startup |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `30000` | Server ping interval; missed pong terminates the socket. Capped at `2147483647`; larger values fail startup |
| `RELAY_CLOSE_TIMEOUT_MS` | `250` | Deadline for a half-open peer to finish closing before `ws.terminate()` is called (also the refused-upgrade raw-socket destroy deadline). Capped at `2147483647`; larger values fail startup |

Each Noise message is capped at 65,535 bytes (plus the five-byte server relay
header). The relay disconnects phones that exceed the byte-rate bucket or
destination queue cap; idle phones also close. Server sockets must register
once, then send only binary relay frames. A disconnected server closes its
phones; a genuine re-registration replaces its older connection. The NEO
server connector additionally caps live relay sessions at 256. See
[`packages/relay/README.md`](../packages/relay/README.md) for the package API.

---

## 6. Local models with Ollama

1. [Install Ollama](https://ollama.com) on the same machine as NEO (or the same
   Docker compose network).
2. Pull a model: `ollama pull llama3.2`
3. In NEO → Settings → Providers → Add provider → choose **Ollama**.
4. Base URL: `http://localhost:11434` (or `http://ollama:11434` in Docker).
5. NEO will list the locally available models automatically.

Memories marked **sensitive** are only shared with providers running on your
own infrastructure (Ollama qualifies; cloud providers do not).

---

## 7. Backups and restore

### What to back up

The **data directory** (`NEO_DATA_DIR`) contains everything:

| File / folder | Contents |
|---|---|
| `neo.db` | SQLite database (conversations, memories, reminders, tasks, notes, settings, push subscriptions, provider configs) |
| `key` | 32-byte AES master key (mode 0600) — **keep this secret** |
| `token` | Owner authentication token |
| `vapid.json` | Web Push VAPID key pair |
| `tunnel-identity.json` | Static tunnel / signing keys (mode 0600); preserve to keep paired phones' pinned identity |
| `plugins/` | Installed plugins (optional) |

**Back up the whole directory**, not just `neo.db` — without the `key` file the
API keys stored in the database are unrecoverable.

### Backup example (Docker)

```bash
# Stop NEO to get a clean snapshot (optional but recommended for large DBs).
docker compose stop neo

# Copy the data volume to a tarball.
docker run --rm \
  -v neo_neo_data:/data:ro \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/neo-backup-$(date +%Y%m%d).tar.gz -C / data

docker compose start neo
```

### Restore

```bash
# Restore the tarball into the volume.
docker run --rm \
  -v neo_neo_data:/data \
  -v "$(pwd)":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/neo-backup-20240101.tar.gz -C /"
```

### Backup example (bare Node)

```bash
# Use SQLite's online backup mode to avoid locking.
cp -a /var/lib/neo /var/lib/neo-backup-$(date +%Y%m%d)

# Or just copy the whole directory:
rsync -a --delete /var/lib/neo/ /mnt/backups/neo/
```

---

## 8. Upgrades

### Docker

```bash
docker compose pull   # pull the new image
docker compose up -d --remove-orphans
docker compose logs -f neo   # watch for startup errors
```

### Bare Node

```bash
cd /opt/neo
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart neo
```

NEO runs database migrations automatically at startup — no manual steps needed.

---

## 9. Security checklist

- [ ] **TLS in production.** Never expose the server over plain HTTP on a public
  network.  Use Caddy, nginx + Certbot, or a cloud load balancer.
- [ ] **Protect your data directory.** Mode `0700` on `dataDir`; the `key` file
  should be mode `0600`.  If you use Docker, do not expose the `neo_data`
  volume over NFS or network storage without encryption.
- [ ] **Do not share your owner token.** Use device pairing to grant access to
  other devices.  Revoke device tokens when decommissioning a device.
- [ ] **Rotate the owner token** if you suspect it was compromised:
  delete `<dataDir>/token` or set a new `NEO_TOKEN`, then restart NEO. Old owner
  tokens stop working; paired devices keep working.
- [ ] **Firewall the server port** (default 7777).  Only the reverse proxy
  should be exposed publicly; bind NEO to `127.0.0.1` and let Caddy/nginx
  handle TLS termination.
- [ ] **Enable proxy trust only behind a trusted proxy.** Set
  `server.trustProxy: true` or `NEO_TRUST_PROXY=true` after blocking direct access
  and configuring the proxy to overwrite client-supplied forwarded IP headers.
- [ ] **Review provider API keys.**  Keys are encrypted at rest with the `key`
  file, but rotate any key you have reason to doubt.
- [ ] **Backups.**  Schedule regular backups of the data directory, especially
  the `key` file (without it, encrypted provider keys are unrecoverable).
- [ ] **Updates.**  Subscribe to release notifications and apply updates promptly,
  especially security patches.
