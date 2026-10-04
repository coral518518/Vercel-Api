export const config = {
  runtime: 'edge',
  regions: ['iad1'], // 严格锁定 AWS 美东机房，拥有原生美国公网 IP
};

const DEFAULT_UPSTREAM = 'https://api.openai.com';
// 可选密钥：若 Vercel 环境变量未配置，会自动降级验证 Worker 特征标头，实现零配置即插即用
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// 严密防御内网与私有 IP 探测
const PRIVATE_IP_REGEX = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fc00:.*\]?|\[?fe80:.*\]?)$/i;

// 必须剔除的代理痕迹标头（特别注意 cdn-loop，防止触发 OpenAI 的 Cloudflare 循环报错）
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'cdn-loop', // 关键：截断 Cloudflare 循环调用计数
  'content-length',
  'x-target-url',
  'x-upstream-url',
  'x-relay-source',
  'x-relay-secret',
  'accept-encoding', // 关键：强制明文，防止 Worker 端的 stream.tee() 记账乱码崩溃
  'via',
]);

const RESPONSE_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'content-encoding',
];

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function buildMergedUrl(rawBaseUrl, incomingUrl) {
  const base = new URL(rawBaseUrl.startsWith('http') ? rawBaseUrl : `https://${rawBaseUrl}`);
  const cleanBasePath = base.pathname.replace(/\/+$/, '');
  const cleanIncomingPath = incomingUrl.pathname.replace(/^\/+/, '');
  base.pathname = cleanBasePath ? `${cleanBasePath}/${cleanIncomingPath}` : `/${cleanIncomingPath}`;
  
  for (const [key, val] of incomingUrl.searchParams.entries()) {
    base.searchParams.set(key, val);
  }
  return base;
}

export default async function handler(request) {
  try {
    const method = request.method.toUpperCase();

    // 1. CORS 跨域处理
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const incomingUrl = new URL(request.url, 'http://localhost');

    // 2. 健康检查与保活（支持 GET 和 HEAD）
    if (['GET', 'HEAD'].includes(method) && (incomingUrl.pathname === '/' || incomingUrl.pathname === '')) {
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }
      return jsonResponse(
        {
          status: 'ok',
          service: 'OneAPI Secondary Relay (IAD1)',
          message: '就绪接收 Cloudflare Worker 中转请求',
          time: new Date().toISOString(),
        },
        200,
        { 'Cache-Control': 'no-store' }
      );
    }

    // 3. 针对你的 Worker 进行的智能安全鉴权
    const clientSecret = request.headers.get('x-relay-secret')?.trim() || '';
    const relaySource = request.headers.get('x-relay-source');
    const hasTargetHeader = !!request.headers.get('x-target-url');

    if (RELAY_SECRET) {
      // 模式 A：如果你配置了密钥，严格进行恒定时间校验
      if (!timingSafeEqual(clientSecret, RELAY_SECRET)) {
        return jsonResponse({ error: { message: 'Unauthorized: x-relay-secret 密钥无效' } }, 403);
      }
    } else {
      // 模式 B：未配密钥时，校验你的 Worker 原生发送的 x-relay-source 标识，防范外部无脑公网扫描
      if (relaySource !== 'cf-worker' && !hasTargetHeader) {
        return jsonResponse({ error: { message: 'Forbidden: 仅限 OneAPI Cloudflare Worker 中转访问' } }, 403);
      }
    }

    // 4. 解析真实目标 URL（优先读取你 Worker 计算好的 x-target-url）
    const targetUrlHeader = request.headers.get('x-target-url');
    const upstreamUrlHeader = request.headers.get('x-upstream-url');
    let finalTargetUrl;

    if (targetUrlHeader && targetUrlHeader.trim()) {
      try {
        finalTargetUrl = new URL(targetUrlHeader.trim());
      } catch {
        finalTargetUrl = buildMergedUrl(DEFAULT_UPSTREAM, incomingUrl);
      }
    } else if (upstreamUrlHeader && upstreamUrlHeader.trim()) {
      finalTargetUrl = buildMergedUrl(upstreamUrlHeader.trim(), incomingUrl);
    } else {
      finalTargetUrl = buildMergedUrl(DEFAULT_UPSTREAM, incomingUrl);
    }

    // 5. SSRF 拦截
    if (!['http:', 'https:'].includes(finalTargetUrl.protocol)) {
      return jsonResponse({ error: '非法请求协议' }, 400);
    }
    const hostname = finalTargetUrl.hostname.toLowerCase();
    if (PRIVATE_IP_REGEX.test(hostname) || !hostname.includes('.')) {
      return jsonResponse({ error: '禁止访问私有内网地址' }, 403);
    }

    // 6. 清洗标头：彻底剥离 CF、Vercel 及中国客户端特征
    const cleanHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith('cf-') ||
        lower.startsWith('x-vercel-') ||
        lower.startsWith('sec-') ||
        lower.includes('forwarded') ||
        lower.includes('client-ip') ||
        lower.includes('real-ip') ||
        HOP_HEADERS.has(lower)
      ) {
        continue;
      }
      cleanHeaders.set(key, value);
    }

    // 保护 UA：确保不漏出 Cloudflare-Workers 标识
    const currentUA = cleanHeaders.get('user-agent') || '';
    if (!currentUA || currentUA.includes('Cloudflare') || currentUA.includes('Vercel')) {
      cleanHeaders.set('user-agent', 'OpenAI/Python 1.30.0');
    }

    // 7. 发起出站请求
    const fetchOptions = {
      method,
      headers: cleanHeaders,
      redirect: 'manual', // 保持 manual，让 Worker 端统一处理重定向
      signal: request.signal, // 与 Worker 端的 60s 超时严格联动，超时即终止上游计费
    };

    if (!['GET', 'HEAD'].includes(method) && request.body) {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half';
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(finalTargetUrl.toString(), fetchOptions);
    } catch (err) {
      if (err.name === 'AbortError') {
        return new Response('Client Aborted', { status: 499, headers: CORS_HEADERS });
      }
      throw err;
    }

    // 8. 构造回传给 Worker 的响应
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(k, v);
    }
    
    for (const h of RESPONSE_HOP_HEADERS) {
      responseHeaders.delete(h);
    }

    // 禁用流式缓冲，保障打字机丝滑
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      responseHeaders.set('Cache-Control', 'no-cache, no-transform');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }

    const responseBody = ([204, 304].includes(upstreamResponse.status) || method === 'HEAD')
      ? null
      : upstreamResponse.body;

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error(`[Relay Error] ${err.message}`);
    return jsonResponse(
      {
        error: {
          message: `Vercel 中转网关执行异常: ${err.message}`,
          type: 'relay_gateway_error',
        },
      },
      502
    );
  }
}
