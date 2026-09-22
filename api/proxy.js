export const config = {
  runtime: 'nodejs',
  regions: ['iad1'],
  maxDuration: 60, // 允许最长 60 秒长连接流式传输
};

// 默认上游为 OpenAI，也支持 Claude 等服务商
const DEFAULT_UPSTREAM = process.env.UPSTREAM_URL || 'https://api.openai.com';

// 需剔除的云厂商、边缘代理与追踪前缀
const STRIP_HEADER_PREFIXES = [
  'x-vercel-',
  'x-forwarded-',
  'cf-',
  'sec-',
];

// 需剔除的敏感/泄露字段
const STRIP_HEADERS = new Set([
  'host',
  'x-real-ip',
  'client-ip',
  'true-client-ip',
  'x-client-ip',
  'cdn-loop',
  'accept-language',
  'origin',
  'referer',
  'cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

async function handle(request) {
  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const incomingUrl = new URL(request.url);

  // 动态上游判断：如果是 Claude 的 /v1/messages 路由，且没有特殊指定，可自动适配 Anthropic
  let targetBase = DEFAULT_UPSTREAM;
  if (incomingUrl.pathname.includes('/v1/messages') && !process.env.UPSTREAM_URL) {
    targetBase = 'https://api.anthropic.com';
  }

  // 拼接目标完整 URL
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, targetBase);

  // 1. 构建干净的目标请求头（深度脱敏）
  const cleanHeaders = new Headers();
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    if (STRIP_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (STRIP_HEADERS.has(lower)) continue;
    cleanHeaders.set(k, v);
  }

  // 2. 指纹规范化伪装（采用主流国际 Python SDK 标识）
  const ua = request.headers.get('user-agent');
  if (!ua || ua.includes('Mozilla') || ua.includes('Vercel') || ua.includes('Cloudflare')) {
    cleanHeaders.set('User-Agent', 'OpenAI/Python 1.30.0');
  } else {
    cleanHeaders.set('User-Agent', ua);
  }
  cleanHeaders.set('Accept-Language', 'en-US,en;q=0.9');
  cleanHeaders.set('Accept-Encoding', 'gzip, deflate, br');

  // 3. 处理请求 Body
  let body = undefined;
  if (!['GET', 'HEAD'].includes(request.method)) {
    body = request.body;
  }

  try {
    const upstreamRes = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: cleanHeaders,
      body,
      // @ts-ignore
      duplex: 'half',
    });

    // 4. 处理返回头，保障流式传输 (SSE) 正常推流
    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Vercel Relay Proxy Error: ${err.message || String(err)}`,
          type: 'proxy_error',
        },
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// 导出所有主流 HTTP 方法支持
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as OPTIONS };
