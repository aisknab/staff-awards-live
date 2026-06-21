const priorities = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = priorities[level] ?? priorities.info;
  function write(entryLevel, message, fields = {}) {
    if ((priorities[entryLevel] ?? 20) < threshold) return;
    const record = {
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...redact(fields),
    };
    const line = `${JSON.stringify(record)}\n`;
    (entryLevel === 'error' ? process.stderr : process.stdout).write(line);
  }
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

function redact(value, key = '') {
  const blocked = /password|secret|token|cookie|authorization|csrf|vote/i;
  if (blocked.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}
