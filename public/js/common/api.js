export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  constructor() {
    this.csrfToken = null;
  }

  setCsrf(token) {
    if (token) this.csrfToken = token;
  }

  async request(path, { method = 'GET', body, csrf = !['GET', 'HEAD'].includes(method), headers = {} } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (csrf && this.csrfToken) requestHeaders['X-CSRF-Token'] = this.csrfToken;
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const contentType = response.headers.get('content-type') ?? '';
    let payload = null;
    if (contentType.includes('application/json')) {
      try { payload = await response.json(); } catch { payload = null; }
    } else {
      payload = await response.text();
    }
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, error.code ?? 'REQUEST_FAILED', error.message ?? `Request failed (${response.status})`, error.details);
    }
    if (payload?.csrfToken) this.setCsrf(payload.csrfToken);
    return payload;
  }
}
