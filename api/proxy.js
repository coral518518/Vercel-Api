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

    // 1. CORS 预检快速通道
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

    // 2. Railway 健康检查探针（快速响应）
    const url = new URL(request.url);
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // =========================================================================
    // 【业务逻辑一】：Privatemode 托管服务模式（仅此服务需校验 RELAY_SECRET 保护自身 Key）
    // =========================================================================
    if (url.pathname.startsWith('/privatemode') || url.pathname.startsWith('/pm')) {
      return await handlePrivatemode(request, url);
    }

    // =========================================================================
    // 【业务逻辑二】：/v1 纯中转透传模式（纯管道：无需校验 RELAY_SECRET，地址与 Auth 100% 原样透传）
    // =========================================================================
    return await handleCloudflareRelay(request, url);

  } catch (err) {
    return new Response(`Relay Error: ${err.message}`, { status: 502 });
  }
}

// -----------------------------------------------------------------------------
// 逻辑二：/v1 纯中转模式（纯管道，地址和 Auth 秘钥 100% 原样透传给服务商）
// -----------------------------------------------------------------------------
async function handleCloudflareRelay(request, url) {
  // 1. 接口目标地址透传：
  // Worker 传了 x-target-url 就直接按指定地址转发；没传就按标准 OpenAI 格式拼上原请求路径
  let targetUrl = request.headers.get('x-target-url');
  if (!targetUrl) {
    const upstream = (request.headers.get('x-upstream-url') || DEFAULT_UPSTREAM).replace(/\/+$/, '');
    targetUrl = `${upstream}${url.pathname}${url.search}`;
  }

  // 2. 标头透传：直接复用，只剔除内部中转头
  // 客户端原本带过来的 Authorization: Bearer <真实模型Key> 原封不动 100% 保留透传！
  const headers = new Headers(request.headers);
  for (let i = 0; i < STRIP_HEADERS.length; i++) {
    headers.delete(STRIP_HEADERS[i]);
  }

  // 设置与目标地址一致的 Host
  try {
    const parsed = new URL(targetUrl);
    headers.set('host', parsed.host);
  } catch {}

  // 强制明文，彻底禁用上游 gzip 窗口缓冲，保持打字机单字实时推送
  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'keep-alive');

  // 3. 极速出站 fetch（纯透传）
  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
    duplex: 'half',
  });

  // 4. 响应回传（防缓冲）
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

// -----------------------------------------------------------------------------
// 逻辑一：Privatemode 托管服务模式（固定服务，使用服务端配置的 PRIVATEMODE_API_KEY）
// -----------------------------------------------------------------------------
async function handlePrivatemode(request, url) {
  // 1. 专属鉴权（仅针对 Privatemode 保护服务端 Key，防止外部盗刷）
  if (RELAY_SECRET) {
    const headerSecret = request.headers.get('x-relay-secret');
    const authHeader = request.headers.get('authorization') || '';
    const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (headerSecret !== RELAY_SECRET && bearerSecret !== RELAY_SECRET) {
      return new Response('Unauthorized', { status: 403 });
    }
  }

  // 2. 路径映射：剥离 /privatemode 或 /pm 前缀，映射到官方 API
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

  try {
    const parsed = new URL(targetUrl);
    headers.set('host', parsed.host);
  } catch {}

  // 3. Privatemode 专用秘钥注入：使用服务端配置的 PRIVATEMODE_API_KEY
  if (PRIVATEMODE_API_KEY) {
    const auth = headers.get('authorization') || '';
    // 如果客户端没填、填了占位符、或是填的网关密码 RELAY_SECRET，统一注入服务端真正的 Privatemode Key
    if (!auth || auth === 'Bearer placeholder' || (RELAY_SECRET && auth === `Bearer ${RELAY_SECRET}`)) {
      headers.set('authorization', `Bearer ${PRIVATEMODE_API_KEY}`);
    }
  }

  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'keep-alive');

  // 4. 出站请求转发
  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
    duplex: 'half',
  });

  // 5. 响应回传
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
