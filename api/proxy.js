export const config = {
  runtime: 'edge',
  regions: ['sfo1'], // 【极速优化】：改为美西旧金山机房！拥有原生美国原生公网 IP，同时比美东 iad1 减少 160ms+ 往返物理延迟
};

const DEFAULT_UPSTREAM = (process.env.DEFAULT_UPSTREAM || 'https://api.openai.com').replace(/\/+$/, '');
const PRIVATEMODE_UPSTREAM = (process.env.PRIVATEMODE_UPSTREAM || 'https://proxyless-api.privatemode.ai').replace(/\/+$/, '');
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();
const PRIVATEMODE_API_KEY = (process.env.PRIVATEMODE_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

// 内部转发时需要剔除的中转头
const STRIP_HEADERS = [
  'host',
  'cdn-loop',
  'x-target-url',
  'x-upstream-url',
  'x-relay-source',
  'x-relay-secret',
  'x-relay-provider',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default async function handler(request) {
  try {
    const method = request.method;
    const incomingUrl = new URL(request.url);
    const pathname = incomingUrl.pathname;

    // 1. CORS 预检快速通道
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. 健康检查接口 (用于 Fly.io / 监控探针)
    if (pathname === '/healthz' || pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          time: new Date().toISOString(),
          uptime: typeof process !== 'undefined' && process.uptime ? process.uptime() : null,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    }

    // 3. 首页服务状态提示
    if (pathname === '/' && method === 'GET') {
      return new Response(
        JSON.stringify({
          service: 'AI Relay Proxy Gateway',
          status: 'running',
          version: '1.0.0',
          interfaces: {
            privatemode: {
              path: '/privatemode/v1/*',
              target: PRIVATEMODE_UPSTREAM + '/v1/*',
              description: 'Privatemode AI 端点 (支持 GLM-5.3, GLM-5.3-Flash, gpt-oss-120b 等)',
            },
            openai: {
              path: '/v1/*',
              target: DEFAULT_UPSTREAM + '/v1/*',
              description: '默认 OpenAI 兼容端点',
            },
            custom: {
              header: 'x-target-url: https://...',
              description: 'OneAPI/CF Worker 自定义绝对目标 URL 转发',
            },
          },
        }, null, 2),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS,
          },
        }
      );
    }

    // 4. 鉴权校验（仅当配置了 RELAY_SECRET 时启用）
    if (RELAY_SECRET) {
      const headerSecret = request.headers.get('x-relay-secret');
      const querySecret = incomingUrl.searchParams.get('relay_secret') || incomingUrl.searchParams.get('key');
      const authHeader = request.headers.get('authorization') || '';
      const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

      const isAuthorized =
        headerSecret === RELAY_SECRET ||
        querySecret === RELAY_SECRET ||
        bearerSecret === RELAY_SECRET;

      if (!isAuthorized) {
        return new Response(
          JSON.stringify({ error: { message: 'Unauthorized: Invalid relay secret', type: 'authentication_error' } }),
          { status: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
    }

    // 5. 目标 URL 路由决策
    const targetUrlHeader = request.headers.get('x-target-url');
    const upstreamUrlHeader = request.headers.get('x-upstream-url');
    const relayProvider = (request.headers.get('x-relay-provider') || '').toLowerCase();

    let finalTargetUrl;
    let isPrivatemode = false;

    if (targetUrlHeader && targetUrlHeader.trim()) {
      // A. 最高优先级：Worker 或客户端明确传入的完整绝对 URL
      finalTargetUrl = targetUrlHeader.trim();
      if (finalTargetUrl.includes('privatemode')) {
        isPrivatemode = true;
      }
    } else if (
      pathname.startsWith('/privatemode/') ||
      pathname === '/privatemode' ||
      pathname.startsWith('/pm/') ||
      pathname === '/pm' ||
      relayProvider === 'privatemode'
    ) {
      // B. Privatemode 专用接口通道
      isPrivatemode = true;
      let subPath = pathname
        .replace(/^\/privatemode\/?/, '/')
        .replace(/^\/pm\/?/, '/');
      if (!subPath.startsWith('/')) {
        subPath = '/' + subPath;
      }
      finalTargetUrl = `${PRIVATEMODE_UPSTREAM}${subPath}${incomingUrl.search}`;
    } else if (upstreamUrlHeader && upstreamUrlHeader.trim()) {
      // C. 基础 upstream 拼接
      const base = upstreamUrlHeader.trim().replace(/\/+$/, '');
      finalTargetUrl = `${base}${pathname}${incomingUrl.search}`;
    } else {
      // D. 默认通用通道 (如直接调用 /v1/chat/completions)
      finalTargetUrl = `${DEFAULT_UPSTREAM}${pathname}${incomingUrl.search}`;
    }

    // 6. Header 清洗与凭证自动填充
    const headers = new Headers(request.headers);
    for (const h of STRIP_HEADERS) {
      headers.delete(h);
    }

    // Privatemode API Key 兜底注入
    if (isPrivatemode && PRIVATEMODE_API_KEY) {
      const currentAuth = headers.get('authorization') || '';
      if (!currentAuth || currentAuth === 'Bearer placeholder' || currentAuth === `Bearer ${RELAY_SECRET}`) {
        headers.set('authorization', `Bearer ${PRIVATEMODE_API_KEY}`);
      }
    } else if (!isPrivatemode && OPENAI_API_KEY) {
      const currentAuth = headers.get('authorization') || '';
      if (!currentAuth || currentAuth === 'Bearer placeholder' || currentAuth === `Bearer ${RELAY_SECRET}`) {
        headers.set('authorization', `Bearer ${OPENAI_API_KEY}`);
      }
    }

    // 设置目标域名 Host 并禁用客户端压缩缓冲，确保打字机单字即时流式推送
    try {
      const parsedTarget = new URL(finalTargetUrl);
      headers.set('host', parsedTarget.host);
    } catch {
      // 如果不是合法的 URL 格式则保持原样
    }
    headers.set('accept-encoding', 'identity');
    headers.set('connection', 'keep-alive');

    // 7. 出站请求转发
    const upstreamResponse = await fetch(finalTargetUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      duplex: 'half',
    });

    // 8. 构造回传响应，剔除干扰流式的标头，注入防缓冲标头
    const resHeaders = new Headers(upstreamResponse.headers);
    resHeaders.delete('content-length');
    resHeaders.delete('content-encoding');

    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      resHeaders.set(k, v);
    }

    // 关键优化：彻底关闭下游缓冲，实现 0 延迟即时 Flush 流式输出
    resHeaders.set('Cache-Control', 'no-cache, no-transform');
    resHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: resHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Relay Error: ${err.message}`,
          type: 'relay_proxy_error',
        },
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }
}
