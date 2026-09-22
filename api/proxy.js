export const config = {
  // 指定部署在 AWS 美东机房 (iad1 - Washington, D.C.)，拥有原生美国公网 IP
  regions: ['iad1'],
};

// 兜底上游服务商地址（当没有标头也没有二次中转配置时）
const DEFAULT_UPSTREAM = 'https://api.openai.com';

/**
 * 通用反向代理处理器：
 * 自动识别 Cloudflare Worker 发来的二次中转请求，读取真实的接口、路径与全部参数，
 * 彻底洗除 Cloudflare 跨区定位指纹，并原生流式返回给 Worker。
 */
export default async function handler(request) {
  // 1. 处理 CORS 跨域预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const incomingUrl = new URL(request.url);

  // 2. 根路径健康检查（便于在浏览器直接访问验证服务是否正常部署）
  if (request.method === 'GET' && (incomingUrl.pathname === '/' || incomingUrl.pathname === '')) {
    return new Response(
      JSON.stringify(
        {
          status: 'ok',
          service: 'OneAPI Vercel Secondary Relay',
          message: '二次中转服务正常运行中。已就绪接收来自 Worker 的自动中转请求。',
          relay_features: {
            auto_detect: true,
            supported_headers: ['x-target-url', 'x-upstream-url', 'x-relay-source'],
            outbound_region: 'AWS us-east-1 (iad1)',
          },
          time: new Date().toISOString(),
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  // 3. 自动识别来自 Worker 的中转请求与真实目标接口
  const targetUrlHeader = request.headers.get('x-target-url');
  const upstreamUrlHeader = request.headers.get('x-upstream-url');
  const isWorkerRelay =
    request.headers.get('x-relay-source') === 'cf-worker' || !!targetUrlHeader;

  let finalTargetUrl;

  if (targetUrlHeader && targetUrlHeader.trim()) {
    // 【最优先】读取 Worker 解析出的 100% 完整目标 URL（已包含完整路径与全部 Query 参数，如 Azure 的 deployment 和 api-version）
    try {
      finalTargetUrl = new URL(targetUrlHeader.trim());
    } catch {
      finalTargetUrl = new URL(targetUrlHeader.trim(), DEFAULT_UPSTREAM);
    }
  } else if (upstreamUrlHeader && upstreamUrlHeader.trim()) {
    // 【次选】读取基础 endpoint，并拼接请求路径与 Query
    const base = upstreamUrlHeader.trim().replace(/\/+$/, '');
    const pathAndQuery = incomingUrl.pathname + incomingUrl.search;
    finalTargetUrl = new URL(base + pathAndQuery);
  } else {
    // 【兜底】直接请求本 Vercel 的外部普通调用，默认映射至 OpenAI
    const base = DEFAULT_UPSTREAM;
    const pathAndQuery = incomingUrl.pathname + incomingUrl.search;
    finalTargetUrl = new URL(base + pathAndQuery);
  }

  console.log(
    `[Relay] 模式: ${isWorkerRelay ? 'CF Worker 中转' : '直接请求'} -> 真实目标: ${finalTargetUrl.toString()}`
  );

  // 4. 清洗 Header：彻底移除会暴露中国客户端定位的 Cloudflare 边缘指纹
  const cleanHeaders = new Headers();
  const hopByHopHeaders = new Set([
    'cf-ray',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-visitor',
    'cf-worker',
    'cdn-loop',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip',
    'x-vercel-id',
    'x-vercel-ip-country',
    'x-vercel-ip-city',
    'x-vercel-forwarded-for',
    'host',
    'content-length',
    'connection',
    'x-target-url',
    'x-upstream-url',
    'x-relay-source',
  ]);

  for (const [key, value] of request.headers.entries()) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      cleanHeaders.set(key, value);
    }
  }

  // 设置正确的目标 Host（解决 TLS SNI 和服务商虚拟主机路由问题）
  cleanHeaders.set('host', finalTargetUrl.hostname);

  // 保障 User-Agent 合规
  if (!cleanHeaders.has('user-agent')) {
    cleanHeaders.set('user-agent', 'OpenAI/Python 1.30.0');
  }

  // 5. 向真实 AI 服务商发起出站请求
  try {
    const fetchOptions = {
      method: request.method,
      headers: cleanHeaders,
      redirect: 'follow',
    };

    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half'; // Node.js 18+ 流式传输请求体兼容
    }

    const upstreamResponse = await fetch(finalTargetUrl.toString(), fetchOptions);

    // 6. 构造返回给 Worker 的响应
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    // 移除已失效的传输编码或长度头，交由运行时自动流式分块
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error(`[Relay Error] 请求上游失败: ${err.message}`);
    return new Response(
      JSON.stringify({
        error: {
          message: `Vercel 中转请求失败: ${err.message}`,
          type: 'relay_proxy_error',
          target: finalTargetUrl ? finalTargetUrl.toString() : 'unknown',
        },
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
