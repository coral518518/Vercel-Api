export const config = {
  runtime: 'edge',
  regions: ['sfo1'], // 【极速优化】：改为美西旧金山机房！拥有原生美国原生公网 IP，同时比美东 iad1 减少 160ms+ 往返物理延迟
};

const DEFAULT_UPSTREAM = 'https://api.openai.com';
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();

// 仅保留 Worker 专用的内部路由头剔除名单
const STRIP_HEADERS = [
  'host',
  'cdn-loop',
  'x-target-url',
  'x-upstream-url',
  'x-relay-source',
  'x-relay-secret',
];

export default async function handler(request) {
  try {
    const method = request.method;

    // 1. CORS 预检快速通道（仅针对浏览器 OPTIONS，正常请求不浪费多余 CORS 标头）
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. 极简鉴权（速度优先：仅在配置了 RELAY_SECRET 时进行毫秒级等值校验）
    if (RELAY_SECRET && request.headers.get('x-relay-secret') !== RELAY_SECRET) {
      return new Response('Unauthorized', { status: 403 });
    }

    // 3. 极速目标 URL 获取（直接使用 Worker 算好的绝对字符串，跳过 new URL 解析）
    const targetUrl = request.headers.get('x-target-url') || DEFAULT_UPSTREAM;

    // 4. 高效标头传递：直接复用，只删无用中转头
    const headers = new Headers(request.headers);
    for (let i = 0; i < STRIP_HEADERS.length; i++) {
      headers.delete(STRIP_HEADERS[i]);
    }

    // 【关键】：强制明文，彻底禁用上游 gzip 窗口缓冲，保持打字机单字实时推送
    headers.set('accept-encoding', 'identity');
    headers.set('connection', 'keep-alive');

    // 5. 极速出站 fetch（原生管道，零额外包装）
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      duplex: 'half',
    });

    // 6. 构造回传响应：精简首部，强力注入防缓冲标头
    const resHeaders = new Headers(upstreamResponse.headers);
    
    // 剔除干扰流式的 hop-by-hop 标头
    resHeaders.delete('content-length');
    resHeaders.delete('content-encoding');

    // 无论任何流，强行关闭下游（Worker 及所有反代）的任何缓冲区，实现 0 延迟即时 Flush
    resHeaders.set('Cache-Control', 'no-cache, no-transform');
    resHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(`Relay Error: ${err.message}`, { status: 502 });
  }
}
