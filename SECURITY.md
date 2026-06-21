# Security and privacy model

## Trust boundaries

The controller, participant, and presentation display use separate opaque session cookies and separate API/SSE endpoints.

- Participant sessions can vote and receive public masked results.
- Display sessions can receive presentation state and the participant join QR.
- Admin sessions can configure events, control state transitions, and receive named tallies.

A session for one role does not grant another role.

## Authentication

The controller uses one configured username and a scrypt password hash. The raw password is never stored by the application.

Sessions use random 256-bit tokens. Only SHA-256 token hashes are stored in SQLite. Cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` whenever `PUBLIC_ORIGIN` uses HTTPS.

QR access tokens are HMAC-derived from the event ID, token purpose, version, and `APP_SECRET`. Rotation increments the corresponding version rather than storing raw QR tokens.

## Request integrity

State-changing authenticated requests require:

- A valid role-specific session cookie
- An exact `Origin` equal to `PUBLIC_ORIGIN`
- A session-derived CSRF token in `X-CSRF-Token`
- JSON content type

CORS is not enabled. Request bodies are capped by default at 32 KiB.

## Masked results

The public masked tally object contains only sorted counts and aggregate metadata. It does not contain nominee identifiers or names. The controller receives the named tally through a different authenticated response path.

Automated tests inspect masked objects and fail if nominee names or IDs appear.

Public updates are delayed and batched. This reduces casual inference but cannot defeat coordinated participants comparing devices and exact voting times.

## Input and output handling

- SQL uses prepared statements and bound values.
- User-facing text is normalised to Unicode NFC and length-limited.
- Browser code inserts user content with `textContent`, not HTML injection APIs.
- A restrictive Content Security Policy allows only same-origin scripts, styles, images, and connections.
- CSV export neutralises formula prefixes and correctly escapes special characters.
- Static files are served from an explicit public directory with path-traversal checks.

## Logging

Logs are structured JSON. The logger redacts fields whose names suggest passwords, secrets, tokens, cookies, CSRF values, authorization data, or votes.

The application does not intentionally persist raw client IP addresses or user-agent strings.

## Reverse proxy

The application binds to loopback by default. Forwarded client IP headers are trusted only when the immediate connection is loopback and `TRUST_LOOPBACK_PROXY=true`.

The gateway must replace forwarded client IP headers rather than accepting attacker-supplied chains.

## Operational risks

- A shared QR code cannot prove one session equals one human.
- Anyone who obtains the display token can see the public presentation state.
- Anyone who obtains the participant token while joining is open can join until the capacity is reached.
- An administrator who shares or exposes the controller screen can disclose the private named tally.
- Database and backup files contain event configuration, sessions, participants, and individual vote records. Protect them with filesystem permissions and backup access controls.

## Incident response

- Rotate the participant link if it is shared unexpectedly.
- Close joining once expected attendees have connected.
- Rotate the display link if the presentation token leaks.
- Revoke suspicious participant sessions from the controller.
- Change `ADMIN_PASSWORD_HASH` and restart if controller credentials may be compromised.
- Change `APP_SECRET` only as a deliberate incident action, because it invalidates derived QR links and CSRF tokens.
