import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = new Map([
  ['/', ['tests/fixtures/demo.html', 'text/html; charset=utf-8']],
  ['/demo.html', ['tests/fixtures/demo.html', 'text/html; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  const route = routes.get(path);
  if (!route) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    response.writeHead(200, {
      'Content-Type': route[1],
      'Cache-Control': 'no-store',
    });
    response.end(await readFile(route[0]));
  } catch {
    response.writeHead(500).end('Unable to read local fixture');
  }
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(4173, '127.0.0.1', () =>
  console.log(
    '开发用测试题: http://127.0.0.1:4173/demo.html（插件运行不需要此服务）',
  ),
);
