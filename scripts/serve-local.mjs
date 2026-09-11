import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.AIOZ_PORT ?? 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AIOZ_PORT must be a valid port.');
const headerFile = await readFile(path.join(root, '_headers'), 'utf8');
const csp = headerFile.match(/Content-Security-Policy: (.*)/)?.[1];
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.txt': 'text/plain;charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (!/^\/(?:index\.html)?$/.test(pathname) && !/^\/(?:xlsx-desensitizer|xlsx-workbook-merger|xlsx-image-link-to-image-tool|qr-code-tool|tampermonkey-scripts)\//.test(pathname)) { response.writeHead(404).end(); return; }
    if (pathname.split('/').some((part) => part.startsWith('.')) || pathname.includes('/src/')) { response.writeHead(404).end(); return; }
    let file = path.resolve(root, `.${pathname}`);
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    file = await realpath(file);
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (pathname.startsWith('/xlsx-desensitizer/') && csp) headers['Content-Security-Policy'] = csp;
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch { response.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}/xlsx-desensitizer/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
