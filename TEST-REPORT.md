# Test report

Date: 21 June 2026
Release: 1.0.0
Target runtime: Node.js 24.17.0

## Automated test suite

Command:

```bash
npm test
```

Result: 14 tests passed, 0 failed.

Coverage includes:

- Admin authentication, secure cookies, CSRF, exact Origin validation, and HTTP security headers
- HMAC join and display tokens, manual codes, scrypt password verification, and CSV formula-injection protection
- QR SVG generation and authenticated participant/display Server-Sent Events
- Event configuration integrity and nominee eligibility validation
- Participant-capacity and anonymous-label integrity after revocation
- Vote replacement before lock and rejection after lock
- Twenty concurrent participants with no nominee mapping in public masked payloads
- Tie handling, joint result calculation, and runoff creation
- Event completion invariants
- Database persistence across a full application restart

## Full event simulation

Command:

```bash
npm run simulate-event
```

Result:

```json
{"status":"passed","participants":20,"maskedCounts":[10,6,3,1],"runoff":true}
```

The simulation creates an isolated temporary event, joins 20 participant sessions, submits concurrent votes, verifies masked public results, locks and reveals the award, and exercises a tied runoff.

## Dependency audit

Command:

```bash
npm audit --omit=dev
```

Result: 0 known vulnerabilities at release time.

## Deployment boundary

The application was tested directly against its Node HTTP server and SQLite database. The existing home-server process manager, Nginx gateway, public hostname, TLS configuration, projector, and attendees' phones are deployment-specific and are covered by `deploy/nginx-requirements.md` and `deploy/event-day-checklist.md`.
