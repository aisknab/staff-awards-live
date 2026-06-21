# Event-day checklist

## Before attendees arrive

1. Run `nvm use` and confirm `node --version` reports Node 24.x.
2. Run `npm test` and `npm run simulate-event` after the final deployment.
3. Create a fresh SQLite-safe backup.
4. Run `npm run restore-check -- <backup-path>` against that backup.
5. Confirm sufficient free disk space on the database and backup volumes.
6. Confirm the application listens only on the intended loopback port.
7. Check `/healthz` and `/readyz` through the public HTTPS hostname.
8. Confirm `PUBLIC_ORIGIN` exactly matches the public hostname.
9. Confirm the gateway has SSE buffering and caching disabled.
10. Sign in to `/admin` on the controller device.
11. Open the private display link on the actual presentation device.
12. Enter fullscreen mode on the presentation page.
13. Scan the participant QR with at least one iPhone and one Android device where available.
14. Test the manual six-character event code.
15. Run a complete rehearsal award: open, vote, close, reveal, and next.
16. Confirm the participant and display network responses show masked counts only before reveal.
17. Confirm the controller alone shows named results.
18. Reset or recreate the rehearsal event before attendees join.

## During the event

1. Open the lobby and leave joining open while attendees connect.
2. Watch joined and connected counts in the controller.
3. Close joining after the expected group is present.
4. Keep the named tally hidden whenever the controller screen might be shared.
5. Use separate controls for close voting and reveal.
6. Resolve a tie with joint winners or a runoff. Do not improvise a random tie-break.
7. Use blank display if private controller work might otherwise appear on the presentation screen.
8. Reopen voting only before reveal.

## Recovery

- Browser refresh: the session and current state should restore automatically.
- Temporary network loss: SSE reconnects automatically and polling begins after ten seconds.
- Node process restart: restart the same service against the same database. Event state and votes persist.
- Leaked participant link: rotate the participant link, then share the new QR/code.
- Leaked display link: rotate it and reconnect the presentation device.
- Suspicious duplicate: revoke the anonymous participant session and close joining.

## After the event

1. Finish the event.
2. Export the final CSV.
3. Create and validate a post-event backup.
4. Store the export and backup according to the organisation's privacy policy.
