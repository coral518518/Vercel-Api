export const config = {
  runtime: 'edge',
  regions: ['sfo1'], // 【极速优化】：美西旧金山机房，原生美国公网 IP
};

const DEFAULT_UPSTREAM = 'https://api.openai.com';
const PRIVATEMODE_UPSTREAM = 'https://proxyless-api.privatemode.ai';
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();
const PRIVATEMODE_API_KEY = (process.env.PRIVATEMODE_API_KEY || '').trim();

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

    // 2. Railway 健康检查探针（快速响应，防止容器探针超时重启）
    const url = new URL(request.url);
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // 3. 极简鉴权（速度优先：仅在配置了 RELAY_SECRET 时进行毫秒级等值校验）
    if (RELAY_SECRET && request.headers.get('x-relay-secret') !== RELAY_SECRET) {
      return new Response('Unauthorized', { status: 403 });
    }

    // =========================================================================
    // 【独立逻辑一】：Privatemode AI 专属中转逻辑（独立路径处理，与 CF 中转完全分离）
    // =========================================================================
    if (url.pathname.startsWith('/privatemode') || url.pathname.startsWith('/pm')) {
      return await handlePrivatemode(request, url);
    }

    // =========================================================================
    // 【独立逻辑二】：Cloudflare Worker 原生中转逻辑（保持你原来的极简原生逻辑 100% 不变）
    // =========================================================================
    return await handleCloudflareRelay(request);

  } catch (err) {
    return new Response(`Relay Error: ${err.message}`, { status: 502 });
  }
}

// -----------------------------------------------------------------------------
// 逻辑二实现：Cloudflare Worker 原生中转（你的原版代码，一字未动，速度优先）
// -----------------------------------------------------------------------------
async function handleCloudflareRelay(request) {
  // 极速目标 URL 获取（直接使用 Worker 算好的绝对字符串，跳过 new URL 解析）
  const targetUrl = request.headers.get('x-target-url') || DEFAULT_UPSTREAM;

  // 高效标头传递：直接复用，只删无用中转头
  const headers = new Headers(request.headers);
  for (let i = 0; i < STRIP_HEADERS.length; i++) {
    headers.delete(STRIP_HEADERS[i]);
  }

  // 【关键】：强制明文，彻底禁用上游 gzip 窗口缓冲，保持打字机单字实时推送
  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'keep-alive');

  // 极速出站 fetch（原生管道，零额外包装）
  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
    duplex: 'half',
  });

  // 构造回传响应：精简首部，强力注入防缓冲标头
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
}

// -----------------------------------------------------------------------------
// 逻辑一实现：Privatemode AI 专属中转（支持 /privatemode/v1/* 及 Key 注入）
// -----------------------------------------------------------------------------
async function handlePrivatemode(request, url) {
  // 1. 路径剥离：将 /privatemode/v1/* 或 /pm/v1/* 转换为上游端点
  let subPath = url.pathname.replace(/^\/(privatemode|pm)/, '');
  if (!subPath.startsWith('/')) subPath = '/' + subPath;
  if (subPath !== '/' && !subPath.startsWith('/v1')) {
    subPath = '/v1' + subPath;
  }
  const targetUrl = request.headers.get('x-target-url') || `${PRIVATEMODE_UPSTREAM}${subPath}${url.search}`;

  // 2. 标头清洗
  const headers = new Headers(request.headers);
  for (let i = 0; i < STRIP_HEADERS.length; i++) {
    headers.delete(STRIP_HEADERS[i]);
  }

  // 3. 目标 Host 设置
  try {
    const parsed = new URL(targetUrl);
    headers.set('host', parsed.host);
  } catch {}

  // 4. 若服务端配置了 PRIVATEMODE_API_KEY，自动为无 key 或占位符请求注入真实 key
  if (PRIVATEMODE_API_KEY) {
    const auth = headers.get('authorization') || '';
    if (!auth || auth === 'Bearer placeholder' || (RELAY_SECRET && auth === `Bearer ${RELAY_SECRET}`)) {
      headers.set('authorization', `Bearer ${PRIVATEMODE_API_KEY}`);
    }
  }

  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'keep-alive');

  // 5. 出站转发
  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
    duplex: 'half',
  });

  // 6. 流式响应防缓冲
  const resHeaders = new Headers(upstreamResponse.headers);
  resHeaders.delete('content-length');
  resHeaders.delete('content-encoding');

  resHeaders.set('Cache-Control', 'no-cache, no-transform');
  resHeaders.set('X-Accel-Buffering', 'no');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: resHeaders,
  });
}
