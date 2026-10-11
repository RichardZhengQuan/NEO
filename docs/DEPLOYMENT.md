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

1. Download the installer for your platform from the releases page.
2. Launch NEO.  The app starts an embedded server on a random localhost port
   and opens the web UI in a native window.
3. On first launch the onboarding wizard guides you through adding an AI
   provider and configuring memory settings.

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

  // Boot-time provider list. Providers added via the UI are stored in the DB.
  "providers": [
    { "id": "demo", "kind": "mock", "label": "Demo mode", "enabled": true }
  ],

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

1. Open **Settings → Devices**.
2. Click **Add device** → choose a name and platform.
3. A QR code and pairing link appear.

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
