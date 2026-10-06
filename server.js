import http from 'node:http';
import handler from './api/proxy.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(async (req, res) => {
  // 1. 【核心优化】：禁用 Nagle 算法，打字机单字 Token 零等待即刻发出
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  // 客户端中断信号监听
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

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

    // 2. 【核心优化】：将进站 JSON 请求体一次性加载进 Buffer，消除 duplex 流式上传等待
    const hasBody = !['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase());
    let body = null;
    if (hasBody) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const webRequest = new Request(fullUrl.toString(), {
      method: req.method,
      headers,
      body,
      signal: abortController.signal,
    });

    const webResponse = await handler(webRequest);

    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }

    // 3. 【核心优化】：立即向下游 Cloudflare Worker 刷新响应头，消除首字假死卡顿
    res.flushHeaders();

    if (webResponse.body) {
      // 4. 【核心优化】：绕过 Node.js 16KB pipe 缓冲，来一个 chunk 毫秒级写入并推向客户端
      const reader = webResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (streamErr) {
        if (!abortController.signal.aborted) {
          res.destroy(streamErr);
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: `Server error: ${err.message}` } }));
    } else {
      res.destroy(err);
    }
  }
});

// 针对 Railway 容器代理层调优长连接
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`[Relay Server] Listening on http://${HOST}:${PORT}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
