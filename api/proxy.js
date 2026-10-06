export const config = {
  runtime: 'edge',
  regions: ['sfo1'], // 【极速优化】：美西旧金山机房，原生美国公网 IP，极速物理延迟
};

// 环境变量在 handler 中动态获取，支持热更新与测试灵活注入

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// 判断是否为需要剥离的特征标头（彻底抹除 Cloudflare、Vercel、Railway 边缘特征与客户端物理 IP）
function shouldStripHeader(name) {
  const lower = name.toLowerCase();
  if (
    lower === 'host' ||
    lower === 'cdn-loop' ||
    lower.startsWith('cf-') ||
    lower.startsWith('x-vercel-') ||
    lower.startsWith('x-railway-') ||
    lower.startsWith('x-forwarded-') ||
    lower === 'x-real-ip' ||
    lower === 'true-client-ip' ||
    lower.startsWith('x-relay-') ||
    lower === 'x-target-url' ||
    lower === 'x-upstream-url' ||
    lower === 'connection' ||
    lower === 'keep-alive' ||
    lower === 'transfer-encoding'
  ) {
    return true;
  }
  return false;
}

// 智能拼接上游基地址与请求路径，避免双重 /v1/v1 等路径错误
function buildUpstreamUrl(baseUrlStr, pathname, search = '') {
  const cleanBase = baseUrlStr.trim().replace(/\/+$/, '');
  let cleanPath = pathname;

  // 若 base 已经带有 /v1 且请求路径也以 /v1 开头，剔除多余的 /v1
  if (cleanBase.endsWith('/v1') && cleanPath.startsWith('/v1')) {
    cleanPath = cleanPath.slice(3);
  }
  if (!cleanPath.startsWith('/')) {
    cleanPath = '/' + cleanPath;
  }
  return `${cleanBase}${cleanPath}${search || ''}`;
}

export default async function handler(request) {
  try {
    const DEFAULT_UPSTREAM = (process.env.DEFAULT_UPSTREAM || 'https://api.openai.com').replace(/\/+$/, '');
    const PRIVATEMODE_UPSTREAM = (process.env.PRIVATEMODE_UPSTREAM || 'https://proxyless-api.privatemode.ai').replace(/\/+$/, '');
    const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();
    const PRIVATEMODE_API_KEY = (process.env.PRIVATEMODE_API_KEY || '').trim();
    const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

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

    // 2. 健康检查接口 (用于 Railway / 监控探针)
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
          service: 'Gateway',
          status: 'running',
          version: '1.0.0',
          interfaces: {},
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

    // 从 Query 中清除 relay_secret，避免向上游泄露鉴权信息
    if (incomingUrl.searchParams.has('relay_secret')) {
      incomingUrl.searchParams.delete('relay_secret');
    }

    // 5. 目标 URL 路由决策
    const targetUrlHeader = request.headers.get('x-target-url');
    const upstreamUrlHeader = request.headers.get('x-upstream-url');
    const relayProvider = (request.headers.get('x-relay-provider') || '').toLowerCase();

    let finalTargetUrl;
    let isPrivatemode = false;

    if (targetUrlHeader && targetUrlHeader.trim()) {
      // A. 最高优先级：Cloudflare Worker 或客户端明确指定的绝对目标 URL
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
      // 容错处理：若客户端直接请求 /privatemode/chat/completions（省略了 /v1），自动补齐 /v1
      if (subPath !== '/' && !subPath.startsWith('/v1/') && subPath !== '/v1') {
        subPath = '/v1' + subPath;
      }
      finalTargetUrl = `${PRIVATEMODE_UPSTREAM}${subPath}${incomingUrl.search}`;
    } else if (upstreamUrlHeader && upstreamUrlHeader.trim()) {
      // C. 动态 upstream 拼接（支持自定义基础端点，自动去除多余 /v1）
      finalTargetUrl = buildUpstreamUrl(upstreamUrlHeader, pathname, incomingUrl.search);
      if (finalTargetUrl.includes('privatemode')) {
        isPrivatemode = true;
      }
    } else {
      // D. 默认通用通道 (如直接调用 /v1/chat/completions)
      finalTargetUrl = buildUpstreamUrl(DEFAULT_UPSTREAM, pathname, incomingUrl.search);
      if (finalTargetUrl.includes('privatemode')) {
        isPrivatemode = true;
      }
    }

    // 6. Header 清洗与凭证自动填充
    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (!shouldStripHeader(key)) {
        headers.set(key, value);
      }
    }

    // Privatemode / OpenAI API Key 兜底注入
    if (isPrivatemode && PRIVATEMODE_API_KEY) {
      const currentAuth = headers.get('authorization') || '';
      if (!currentAuth || currentAuth === 'Bearer placeholder' || currentAuth === `Bearer ${RELAY_SECRET}`) {
        headers.set('authorization', `Bearer ${PRIVATEMODE_API_KEY}`);
      }
      const currentXKey = headers.get('x-api-key') || '';
      if (currentXKey === 'placeholder' || (RELAY_SECRET && currentXKey === RELAY_SECRET)) {
        headers.set('x-api-key', PRIVATEMODE_API_KEY);
      }
    } else if (!isPrivatemode && OPENAI_API_KEY) {
      const currentAuth = headers.get('authorization') || '';
      if (!currentAuth || currentAuth === 'Bearer placeholder' || currentAuth === `Bearer ${RELAY_SECRET}`) {
        headers.set('authorization', `Bearer ${OPENAI_API_KEY}`);
      }
    }

    // 保护 User-Agent：若无 UA 或检测到 Cloudflare-Workers / Vercel 特征标识，清洗为官方标准标识
    const currentUA = headers.get('user-agent') || '';
    if (!currentUA || currentUA.includes('Cloudflare') || currentUA.includes('Vercel')) {
      headers.set('user-agent', 'OpenAI/Python 1.30.0');
    }

    // 设置目标域名 Host 并禁用客户端压缩缓冲，确保打字机单字即时流式推送
    try {
      const parsedTarget = new URL(finalTargetUrl);
      headers.set('host', parsedTarget.host);
    } catch {
      // 非合法 URL 格式保持原样
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

    // 关键优化：彻底关闭下游（Cloudflare / 反向代理）缓冲，实现 0 延迟即时 Flush 流式输出
    resHeaders.set('Cache-Control', 'no-cache, no-transform');
    resHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: resHeaders,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return new Response(null, { status: 499, headers: CORS_HEADERS });
    }
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
