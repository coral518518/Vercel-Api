import http from 'node:http';
import { Readable } from 'node:stream';
import handler from './api/proxy.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(async (req, res) => {
  // 保持连接活跃，防止长时间流式传输中断
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['host'] || `localhost:${PORT}`;
    const fullUrl = new URL(req.url, `${protocol}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
    }

    const hasBody = !['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase());
    const body = hasBody ? Readable.toWeb(req) : null;

    const webRequest = new Request(fullUrl.toString(), {
      method: req.method,
      headers,
      body,
      duplex: hasBody ? 'half' : undefined,
    });

    const webResponse = await handler(webRequest);

    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }

    if (webResponse.body) {
      const nodeReadable = Readable.fromWeb(webResponse.body);
      nodeReadable.on('error', (err) => {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: { message: `Stream error: ${err.message}` } }));
        }
      });
      nodeReadable.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: `Server error: ${err.message}` } }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Relay Server] Listening on http://${HOST}:${PORT}`);
  console.log(`[Relay Server] Endpoints:`);
  console.log(`  - Healthcheck: http://${HOST}:${PORT}/healthz`);
  console.log(`  - Privatemode: http://${HOST}:${PORT}/privatemode/v1/chat/completions`);
  console.log(`  - OpenAI:      http://${HOST}:${PORT}/v1/chat/completions`);
});

const shutdown = () => {
  console.log('[Relay Server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
