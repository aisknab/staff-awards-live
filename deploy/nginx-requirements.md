# Nginx gateway requirements

The application listens on a loopback address such as `127.0.0.1:8787`. The existing gateway should terminate HTTPS and proxy a dedicated hostname to that port.

Representative requirements:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
```

Important points:

- Use a dedicated public origin such as `https://awards.example.com`.
- Make `PUBLIC_ORIGIN` exactly match the browser-facing origin.
- Do not expose the Node port publicly.
- Keep the upstream connection on HTTP/1.1 for Server-Sent Events.
- Disable buffering and caching. The application also sends `X-Accel-Buffering: no` and no-store headers.
- Replace `X-Forwarded-For` with the real client address at the trusted edge. Do not pass an untrusted incoming header through unchanged.
- Preserve the public `Host` and scheme.
- Do not apply response transforms to `text/event-stream`.
- Ensure gateway timeouts do not terminate quiet SSE connections. The application emits a keepalive every 15 seconds.
- Avoid caching `/api/*`, HTML pages, and QR responses.

The exact syntax may differ in the existing gateway service. These are behavioural requirements, not a request to replace its configuration.
