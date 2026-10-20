const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.WORKFLOW_MOCK_PORT || 41739);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = fs.readFileSync(file);
  } catch (_) {
    response.writeHead(404).end();
    return;
  }
  if (pathname === '/workflow.html') {
    body = Buffer.from(body.toString().replace('./workflow-store.js', './tests/workflow-store.mock.js'));
  }
  response.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}).listen(port, '127.0.0.1', () => console.log(`Mock workflow server on http://127.0.0.1:${port}/workflow.html`));
