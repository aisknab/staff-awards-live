import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { securityHeaders } from './security.js';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
});

export async function serveStatic(req, res, publicDir, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  let relative;
  if (pathname === '/') relative = 'index.html';
  else if (pathname === '/admin') relative = 'admin.html';
  else if (pathname === '/display') relative = 'display.html';
  else relative = pathname.replace(/^\/+/, '');

  if (!relative || relative.includes('\0') || relative.split('/').includes('..')) return false;
  const root = resolve(publicDir);
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;
  const extension = extname(filePath).toLowerCase();
  const contentType = MIME[extension];
  if (!contentType) return false;
  try {
    const data = await readFile(filePath);
    const isHtml = extension === '.html';
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}
