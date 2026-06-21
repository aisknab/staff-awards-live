# Staff Awards Live

A small self-hosted web application for live staff-award voting. Participants join from one QR code, vote anonymously from their phones, and see a live masked distribution. The controller privately sees the named tally and decides when to close voting and reveal the winner.

The project is intentionally bespoke and dependency-light:

- Node.js 24 LTS
- Native `node:http`
- Native `node:sqlite`
- Native Server-Sent Events
- Vanilla HTML, CSS, and browser JavaScript
- One direct npm dependency: `qrcode`
- No frontend build step
- No Docker, ORM, framework, JWT, or WebSocket server

## Features

- Mobile participant voting through a QR link or six-character event code
- Private controller dashboard with exact named results
- Separate presentation display for a projector or shared screen
- Server-side masked tallies that contain counts but no nominee mapping
- Batched public tally updates to reduce casual vote inference
- Vote changes until the controller locks the round
- Joint-winner and runoff handling
- Event, vote, session, and reveal persistence in SQLite
- Reusable saved people lists for future event setup
- Automatic browser reconnection through SSE with polling fallback
- Secure opaque cookies, CSRF tokens, exact Origin validation, rate limits, and security headers
- QR token rotation, participant revocation, emergency display blanking, CSV export, backups, and health endpoints

## Runtime isolation

The application deliberately requires Node.js 24.x. This allows it to coexist with other applications using different Node versions.

```bash
cd /srv/staff-awards
nvm install
nvm use
node --version
```

`.nvmrc` pins Node.js 24.17.0, and the production entry point exits when another Node major version is used. A process manager or systemd service should use the explicit Node 24 binary path rather than whichever `node` happens to be globally available.

## Installation

```bash
git clone <your-repository-url> /srv/staff-awards
cd /srv/staff-awards

nvm install
nvm use
npm ci --omit=dev
```

Generate the application secret:

```bash
npm run create-secret
```

Generate the password hash through a hidden terminal prompt:

```bash
npm run create-admin-hash
```

Create data directories:

```bash
sudo install -d -m 0750 -o YOUR_USER -g YOUR_GROUP /var/lib/staff-awards
sudo install -d -m 0750 -o YOUR_USER -g YOUR_GROUP /var/backups/staff-awards
```

Copy `.env.example` to a protected location outside the repository and insert the generated values:

```bash
sudo cp .env.example /etc/staff-awards.env
sudo chmod 0600 /etc/staff-awards.env
sudo chown YOUR_USER:YOUR_GROUP /etc/staff-awards.env
```

Start the application manually:

```bash
cd /srv/staff-awards
nvm use
node --env-file=/etc/staff-awards.env src/server.js
```

The default listener is `127.0.0.1:8787`. It does not bind publicly unless `HOST` is deliberately changed.

## Existing Nginx gateway

Point the existing gateway at the configured loopback port. The application expects a dedicated origin such as `https://awards.example.com`, not a subdirectory.

SSE requires these upstream characteristics:

- HTTP/1.1 upstream
- Proxy buffering disabled
- Proxy caching disabled for the application
- A long read timeout
- Public `Host` and scheme forwarded
- Client IP headers replaced by the trusted gateway, not blindly appended

A minimal reference is in [`deploy/nginx-requirements.md`](deploy/nginx-requirements.md). The application also emits `X-Accel-Buffering: no` on SSE responses.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `NODE_ENV` | Production | `development` | Set to `production` on the server |
| `HOST` | No | `127.0.0.1` | Local bind address |
| `PORT` | No | `8787` | Unique local application port |
| `PUBLIC_ORIGIN` | Production | `http://127.0.0.1:8787` | Exact public HTTPS origin used for links and Origin checks |
| `DATABASE_PATH` | No | `./data/staff-awards.sqlite` | SQLite file location |
| `APP_SECRET` | Production | Development-only value | HMAC and CSRF derivation secret, at least 32 bytes |
| `ADMIN_USERNAME` | No | `admin` | Single controller username |
| `ADMIN_PASSWORD_HASH` | Production | None | Encoded scrypt password hash |
| `ADMIN_SESSION_HOURS` | No | `12` | Admin session lifetime |
| `PARTICIPANT_SESSION_HOURS` | No | `18` | Participant session lifetime |
| `DISPLAY_SESSION_HOURS` | No | `24` | Display session lifetime |
| `TRUST_LOOPBACK_PROXY` | No | `true` | Trust forwarded client IP only from loopback |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `MAX_BODY_BYTES` | No | `32768` | Maximum JSON body size |
| `MASKED_MIN_VOTES` | No | `3` | Votes required before anonymous bars appear |
| `MASKED_MIN_INTERVAL_MS` | No | `2000` | Minimum public tally publish interval |
| `MASKED_MAX_DELAY_MS` | No | `5000` | Maximum delay for a pending public update |
| `BACKUP_DIR` | No | `./backups` | Backup destination |
| `BACKUP_RETENTION_DAYS` | No | `14` | Automatic backup retention |

Production startup fails rather than silently inventing missing secrets.

## Controller workflow

1. Open `/admin` and sign in.
2. Create an event.
3. Load a saved people list or paste one nominee per line. Add an optional team after `|`.
4. Save or update the people list if it should be reused for future events.
5. Add and order the awards, then choose the eligible nominees for each.
6. Save the draft and open the lobby.
7. Open the private presentation link on the projector or shared-screen device.
8. Show the participant QR code and manual event code.
9. Show the first award, then open voting.
10. Watch the private named tally while public clients receive only masked counts.
11. Close voting.
12. Reveal the winner, reveal joint winners, or start a runoff when tied.
13. Move to the next award.
14. Export the final CSV after the event.

Reveal and destructive actions require confirmation in the controller UI. A revealed round cannot be reopened or reset. A finished event can be reopened to keep existing participants and results, or restarted from the lobby with the same configuration after clearing participants, rounds, votes, and revealed results.

## Masking model

Before reveal, public tally objects contain only a descending list of vote counts and aggregate metadata. They do not contain nominee IDs, names, subtitles, stable candidate aliases, or nominee-specific colours.

Participants still receive the nominee list because they must be able to vote. The security boundary is that no count is mapped to a nominee before reveal.

Public count updates are batched:

- No bars before three votes by default
- At most one published update every two seconds
- Prefer at least two changed votes per update
- Publish after five seconds at the latest
- Publish the final masked distribution immediately when voting locks

This prevents explicit disclosure and reduces casual inference. It does not provide cryptographic anonymity against coordinated participants comparing devices and timing.

A shared QR code enforces one vote per browser session, not one vote per verified human. A determined attendee could use multiple devices or cleared browser profiles. The controller can cap attendance, close joining, and revoke obvious duplicates. Strong identity enforcement would require individual one-time codes, which this purpose-built version intentionally omits.

## Database and migrations

SQLite is configured with:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

Numbered SQL migrations are applied transactionally at startup and recorded in `schema_migrations`. Startup stops on migration failure.

Run migrations without starting HTTP:

```bash
node --env-file=/etc/staff-awards.env src/migrate-cli.js
```

or:

```bash
npm run migrate
```

## Backups

Create a SQLite-safe timestamped backup:

```bash
node --env-file=/etc/staff-awards.env scripts/backup.js
```

or:

```bash
npm run backup
```

Do not copy only the main `.sqlite` file while WAL mode is active.

Validate a backup before relying on it:

```bash
npm run restore-check -- /var/backups/staff-awards/staff-awards-YYYYMMDDTHHMMSSZ.sqlite
```

To restore:

1. Stop the application.
2. Take one final backup of the current database.
3. Copy the validated backup to `DATABASE_PATH` using the same owner and restrictive permissions.
4. Remove stale `-wal` and `-shm` files only while the application is stopped.
5. Start the application and check `/readyz`.

## Tests

Install all dependencies and run the native Node test suite:

```bash
nvm use
npm ci
npm test
```

The suite covers authentication, CSRF, Origin enforcement, security headers, QR and SSE delivery, 20 concurrent participants, masked-payload leakage, vote replacement, lock rejection, ties, runoffs, state integrity, and restart persistence. GitHub Actions runs the same suite and event simulation on the pinned Node version.

Run the standalone 20-participant event simulation:

```bash
npm run simulate-event
```

Seed a reusable draft demonstration event into the configured database:

```bash
node --env-file=/etc/staff-awards.env scripts/seed-demo.js --yes
```

## Health checks

```text
GET /healthz
GET /readyz
```

`/readyz` performs a database query and checks that migrations exist. Neither endpoint exposes event or filesystem details.

## Process management

A generic systemd example is provided at [`deploy/staff-awards.service.example`](deploy/staff-awards.service.example). Replace the username, paths, and exact Node 24 installation path.

The important part is an explicit executable such as:

```ini
ExecStart=/home/YOUR_USER/.nvm/versions/node/v24.17.0/bin/node --env-file=/etc/staff-awards.env /srv/staff-awards/src/server.js
```

The same principle applies to another process manager: set the working directory, environment file, and exact Node 24 binary for this application.

## Updating

```bash
cd /srv/staff-awards
nvm use
node --env-file=/etc/staff-awards.env scripts/backup.js

git pull --ff-only
npm ci --omit=dev
npm test
```

Restart the process through the existing process manager, then verify `/readyz`, `/admin`, the participant QR, and the presentation display.

## Event-day preparation

Use [`deploy/event-day-checklist.md`](deploy/event-day-checklist.md). Rehearse the complete flow with real phones and the actual presentation device before the event.
