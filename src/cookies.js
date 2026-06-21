export const COOKIE_NAMES = Object.freeze({
  ADMIN: 'awards_admin_session',
  PARTICIPANT: 'awards_participant_session',
  DISPLAY: 'awards_display_session',
});

export function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try { result[name] = decodeURIComponent(raw); } catch { result[name] = raw; }
  }
  return result;
}

export function serializeCookie(name, value, { secure, maxAge, path = '/', sameSite = 'Strict', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}
