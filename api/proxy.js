export const config = {
  runtime: 'edge',
  regions: ['sfo1'], // 【极速优化】：美西旧金山机房，原生美国公网 IP
};

const DEFAULT_UPSTREAM = 'https://api.openai.com';
const PRIVATEMODE_UPSTREAM = 'https://proxyless-api.privatemode.ai';
const CLIXAD_UPSTREAM = (process.env.CLIXAD_UPSTREAM || 'https://clixad.onrender.com').replace(/\/+$/, '');
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();
const PRIVATEMODE_API_KEY = (process.env.PRIVATEMODE_API_KEY || '').trim();
const CLIXAD_API_KEY = (process.env.CLIXAD_API_KEY || process.env.CLIXAD_TOKEN || '').trim();
const GITHUB_COOKIE = (process.env.GITHUB_COOKIE || process.env.GITHUB_SESSION || '').trim();
const CLIXAD_KV_SELECT_URL = (process.env.CLIXAD_KV_SELECT_URL || 'https://d1.coral001.de5.net/common_data/kvselect/clixad').trim();
const CLIXAD_KV_ADD_URL = (process.env.CLIXAD_KV_ADD_URL || 'https://d1.coral001.de5.net/common_data/kvadd/clixad').trim();

// =============================================================================
// Clixad 秘钥存储管理：内存缓存 + 远程 D1 KV 端点 + 本地文件容灾双向同步
// =============================================================================
let hostedToken = CLIXAD_API_KEY;
let hostedAccount = null;
let lastKvFetchTime = 0;
const KV_CACHE_TTL = 60 * 1000; // 内存缓存 1 分钟，减少高频网络请求

async function fetchRemoteKvTokens() {
  if (!CLIXAD_KV_SELECT_URL) return null;
  try {
    const res = await fetch(CLIXAD_KV_SELECT_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const raw = await res.text().catch(() => '');
    if (!raw || !raw.trim()) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [{ token: raw.trim() }];
    }

    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.keys)) return data.keys;
      if (Array.isArray(data.tokens)) return data.tokens;
      if (typeof data.current_token === 'string' && data.current_token) {
        return [{ token: data.current_token }];
      }
    }
  } catch (err) {
    console.warn('[Remote KV] 获取失败:', err.message);
  }
  return null;
}

async function syncTokenToRemoteKv(tokenData) {
  if (!CLIXAD_KV_ADD_URL) return;
  try {
    // 1. 先通过 kvselect 获取接口已有数据
    let existingData = null;
    if (CLIXAD_KV_SELECT_URL) {
      try {
        const selRes = await fetch(CLIXAD_KV_SELECT_URL, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000)
        });
        if (selRes.ok) {
          const raw = await selRes.text().catch(() => '');
          if (raw && raw.trim()) {
            try {
              existingData = JSON.parse(raw);
            } catch {
              existingData = raw.trim();
            }
          }
        }
      } catch (e) {
        console.warn('[Remote KV] 读取现有数据失败，将作为首次写入:', e.message);
      }
    }

    let payload;
    if (Array.isArray(existingData)) {
      const isStringArray = existingData.length > 0 && existingData.every(x => typeof x === 'string');
      const list = existingData.filter(item => {
        const t = typeof item === 'string' ? item : item?.token;
        return t && t !== tokenData.token;
      });
      list.push(isStringArray ? tokenData.token : tokenData);
      payload = list;
    } else if (existingData && typeof existingData === 'object') {
      let list = Array.isArray(existingData.keys) ? existingData.keys :
                 Array.isArray(existingData.tokens) ? existingData.tokens : [];
      list = list.filter(item => {
        const t = typeof item === 'string' ? item : item?.token;
        return t && t !== tokenData.token;
      });
      list.push(tokenData);
      payload = {
        ...existingData,
        current_token: tokenData.token,
        keys: list,
        count: list.length,
        updated_at: Date.now()
      };
      if (payload.test) delete payload.test;
    } else if (typeof existingData === 'string' && existingData) {
      payload = existingData === tokenData.token ? [tokenData] : [existingData, tokenData];
    } else {
      payload = {
        current_token: tokenData.token,
        keys: [tokenData],
        count: 1,
        updated_at: Date.now()
      };
    }

    // 2. 将追加后的数据 POST 提交至 kvadd
    const addRes = await fetch(CLIXAD_KV_ADD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    const addText = await addRes.text().catch(() => '');
    console.log(`[Remote KV] 秘钥已成功同步写入 ${CLIXAD_KV_ADD_URL}: status=${addRes.status}, resp=${addText}`);
    return payload;
  } catch (err) {
    console.error('[Remote KV] 写入远程 KV 失败:', err.message);
  }
}

async function getStoredToken() {
  if (CLIXAD_API_KEY) return CLIXAD_API_KEY;

  const now = Date.now();
  if (hostedToken && (now - lastKvFetchTime < KV_CACHE_TTL)) {
    return hostedToken;
  }

  // 优先从远程 D1 KV 端点获取
  const remoteTokens = await fetchRemoteKvTokens();
  if (remoteTokens && remoteTokens.length > 0) {
    const latest = remoteTokens[remoteTokens.length - 1];
    const tok = typeof latest === 'string' ? latest : latest?.token;
    if (tok) {
      hostedToken = tok;
      hostedAccount = typeof latest === 'object' ? latest : { token: tok };
      lastKvFetchTime = now;
      return hostedToken;
    }
  }

  // 回退检查本地文件 (.clixad_token.json)
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tokenFile = path.resolve(process.cwd(), '.clixad_token.json');
    const content = await fs.readFile(tokenFile, 'utf8');
    const data = JSON.parse(content);
    if (data?.token) {
      hostedToken = data.token;
      hostedAccount = data;
      lastKvFetchTime = now;
      return hostedToken;
    }
  } catch { }

  return hostedToken || '';
}

async function saveStoredToken(tokenData) {
  hostedToken = tokenData.token;
  hostedAccount = tokenData;
  lastKvFetchTime = Date.now();

  // 1. 本地文件持久化（本地容灾备用）
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tokenFile = path.resolve(process.cwd(), '.clixad_token.json');
    await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2), 'utf8');
  } catch { }

  // 2. 远程 D1 KV 同步（非阻塞异步写入，避免外部接口网络抖动卡死前端响应）
  syncTokenToRemoteKv(tokenData).catch(err => {
    console.warn('[Remote KV] 异步写入失败:', err.message);
  });
}

// -----------------------------------------------------------------------------
// 服务端后台全自动监听轮询（解耦客户端浏览器休眠与网络挂起）
// -----------------------------------------------------------------------------
const activePollSessions = new Set();

function startServerSidePolling(session) {
  if (!session || activePollSessions.has(session)) return;
  activePollSessions.add(session);

  let attempts = 0;
  const maxAttempts = 120; // 轮询最多 6 分钟 (每 3 秒一次)
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts || !activePollSessions.has(session)) {
      clearInterval(timer);
      activePollSessions.delete(session);
      return;
    }

    try {
      const res = await fetch(`${CLIXAD_UPSTREAM}/v1/auth/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session })
      });
      const data = await res.json().catch(() => ({}));
      if (data.token || data.status === 'complete') {
        clearInterval(timer);
        activePollSessions.delete(session);
        console.log('[Clixad] 服务端后台捕获到 GitHub 授权 Token:', data.login || data.email || 'user');
        await saveStoredToken({
          token: data.token,
          userId: data.userId,
          email: data.email,
          login: data.login,
          balance: data.balance,
          created: data.created,
          created_at: Date.now()
        });
        fetch(`${CLIXAD_UPSTREAM}/v1/streak/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${data.token}`
          }
        }).catch(() => {});
      } else if (data.status === 'closed' || data.status === 'expired') {
        clearInterval(timer);
        activePollSessions.delete(session);
      }
    } catch { }
  }, 3000);
}

// 仅保留 Worker 专用的内部路由头剔除名单
const STRIP_HEADERS = [
  'host',
  'cdn-loop',
  'transfer-encoding',
  'connection',
  'keep-alive',
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
    // 【业务逻辑二】：Clixad (https://clixad.io) 托管/中转服务模式
    // =========================================================================
    if (
      url.pathname.startsWith('/clixad') ||
      url.pathname.startsWith('/cx') ||
      url.pathname.startsWith('/clixadio')
    ) {
      return await handleClixad(request, url);
    }

    // =========================================================================
    // 【业务逻辑三】：/v1 纯中转透传模式（纯管道：无需校验 RELAY_SECRET，地址与 Auth 100% 原样透传）
    // =========================================================================
    return await handleCloudflareRelay(request, url);

  } catch (err) {
    return new Response(`Relay Error: ${err.message} (${err.cause?.message || err.cause || ''})`, { status: 502 });
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
  } catch { }

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
  } catch { }

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

// -----------------------------------------------------------------------------
// 业务逻辑：Clixad (https://clixad.io) 托管与中转服务模式（支持云端全自动免 CLI 认证）
// -----------------------------------------------------------------------------
async function handleClixad(request, url) {
  const normPath = url.pathname.toLowerCase().replace(/\/+$/, '');

  // 1. 云端 Web 一键认证页面与辅助接口（免装本地任何 npm 环境与终端）
  if (
    normPath === '/clixad/login' ||
    normPath === '/cx/login' ||
    normPath === '/clixad/auth' ||
    normPath === '/cx/auth'
  ) {
    return await handleClixadLoginUi(request, url);
  }
  if (normPath === '/clixad/auth/start' || normPath === '/cx/auth/start') {
    return await handleClixadAuthStart(request, url);
  }
  if (normPath === '/clixad/auth/poll' || normPath === '/cx/auth/poll') {
    return await handleClixadAuthPoll(request, url);
  }
  if (normPath === '/clixad/token' || normPath === '/cx/token') {
    return await handleClixadSaveToken(request, url);
  }
  if (normPath === '/clixad/status' || normPath === '/cx/status') {
    return await handleClixadStatus(request, url);
  }

  // 2. 专属鉴权（若设置 RELAY_SECRET，校验秘钥以保护服务端 Token 防止外部盗刷）
  if (RELAY_SECRET) {
    const headerSecret = request.headers.get('x-relay-secret');
    const authHeader = request.headers.get('authorization') || '';
    const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (headerSecret !== RELAY_SECRET && bearerSecret !== RELAY_SECRET) {
      return new Response('Unauthorized', { status: 403 });
    }
  }

  // 3. 路径映射：剥离 /clixad.io, /clixadio, /clixad 或 /cx 前缀，映射到官方 API 路径
  let subPath = url.pathname.replace(/^\/(clixad\.io|clixadio|clixad|cx)/i, '');
  if (!subPath.startsWith('/')) subPath = '/' + subPath;
  if (
    subPath !== '/' &&
    !subPath.startsWith('/v1') &&
    !subPath.startsWith('/dev') &&
    subPath !== '/healthz' &&
    subPath !== '/health'
  ) {
    subPath = '/v1' + subPath;
  }
  const upstream = (request.headers.get('x-upstream-url') || CLIXAD_UPSTREAM).replace(/\/+$/, '');
  const targetUrl = request.headers.get('x-target-url') || `${upstream}${subPath}${url.search}`;

  // 4. 标头清洗
  const headers = new Headers(request.headers);
  for (let i = 0; i < STRIP_HEADERS.length; i++) {
    headers.delete(STRIP_HEADERS[i]);
  }

  try {
    const parsed = new URL(targetUrl);
    headers.set('host', parsed.host);
  } catch { }

  // 5. Clixad 自动秘钥解析与注入
  let token = await getStoredToken();
  const auth = headers.get('authorization') || '';
  const isCustomClientToken = auth && auth !== 'Bearer placeholder' && (!RELAY_SECRET || auth !== `Bearer ${RELAY_SECRET}`);

  if (!isCustomClientToken) {
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    } else {
      // 若配置了 GITHUB_COOKIE，尝试全自动无感静默认证
      if (GITHUB_COOKIE) {
        token = await autoLoginClixadWithGitHub();
        if (token) {
          headers.set('authorization', `Bearer ${token}`);
        }
      }

      // 若仍未获取到 Token，在调用需要认证的模型接口时，返回友好的指引错误
      if (!headers.has('authorization') && (subPath.startsWith('/v1/chat') || subPath.startsWith('/v1/completions') || subPath.startsWith('/v1/wallet'))) {
        return new Response(JSON.stringify({
          error: {
            message: 'Clixad 云端尚未完成账号认证。请先在浏览器中访问 ' + url.origin + '/clixad/login 完成一次性快速授权（无需安装本地环境），即可自动生效！',
            type: 'clixad_auth_required',
            login_url: `${url.origin}/clixad/login`
          }
        }, null, 2), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }
  }

  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'keep-alive');

  // 6. 出站请求转发
  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    signal: request.signal,
    duplex: 'half',
  });

  // 7. 响应回传（防缓冲）
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
// Clixad 辅助函数：Web 登录界面、设备流程、状态监控、GitHub 静默授权
// -----------------------------------------------------------------------------
async function handleClixadLoginUi(request, url) {
  const token = await getStoredToken();
  const force = url.searchParams.get('force') === '1';

  let accountInfo = hostedAccount;
  if (token && !accountInfo) {
    try {
      const res = await fetch(`${CLIXAD_UPSTREAM}/v1/wallet?premium=1`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data?.balance !== undefined) {
        accountInfo = { balance: data.balance, login: '已托管 Token' };
      }
    } catch { }
  }

  const html = renderLoginPage({
    activeToken: force ? '' : token,
    account: accountInfo,
    origin: url.origin
  });

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function handleClixadAuthStart(request, url) {
  try {
    const res = await fetch(`${CLIXAD_UPSTREAM}/v1/auth/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Clixad start failed: ${res.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const data = await res.json();

    // 启动服务端独立后台轮询（解耦客户端浏览器休眠）
    if (data.session) {
      startServerSidePolling(data.session);
    }

    if (GITHUB_COOKIE && data.user_code) {
      autoApproveGitHubDevice(data.user_code, GITHUB_COOKIE).catch(() => {});
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}

async function handleClixadAuthPoll(request, url) {
  const session = url.searchParams.get('session');
  if (!session) {
    return new Response(JSON.stringify({ error: 'Missing session parameter' }), { status: 400 });
  }

  // 1. 如果服务端已由后台轮询或手动配置捕获到 Token，直接极速返回成功！
  if (hostedToken) {
    return new Response(JSON.stringify({
      status: 'complete',
      token: hostedToken,
      ...hostedAccount
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const res = await fetch(`${CLIXAD_UPSTREAM}/v1/auth/device/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session })
    });
    const data = await res.json().catch(() => ({}));
    if (data.token || data.status === 'complete') {
      await saveStoredToken({
        token: data.token,
        userId: data.userId,
        email: data.email,
        login: data.login,
        balance: data.balance,
        created: data.created,
        created_at: Date.now()
      });
      fetch(`${CLIXAD_UPSTREAM}/v1/streak/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${data.token}`
        }
      }).catch(() => {});
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502 });
  }
}

async function handleClixadSaveToken(request, url) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      const text = await request.text();
      body = { token: text.trim() };
    }
    const token = (body.token || '').trim();
    if (!token) {
      return new Response(JSON.stringify({ error: 'Token 不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let account = { token, login: '手动绑定账号', created_at: Date.now() };
    try {
      const wRes = await fetch(`${CLIXAD_UPSTREAM}/v1/wallet?premium=1`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        if (wData.balance !== undefined) account.balance = wData.balance;
      }
    } catch { }

    await saveStoredToken(account);
    return new Response(JSON.stringify({ success: true, message: 'Token 已成功绑定并同步至 D1 KV', account }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

async function handleClixadStatus(request, url) {
  const token = await getStoredToken();
  if (!token) {
    return new Response(JSON.stringify({
      authenticated: false,
      message: '云端未保存有效 Token，请在浏览器中访问 /clixad/login 完成一次性快速授权',
      login_url: `${url.origin}/clixad/login`
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  try {
    const [walletRes, modelsRes] = await Promise.all([
      fetch(`${CLIXAD_UPSTREAM}/v1/wallet?premium=1`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }),
      fetch(`${CLIXAD_UPSTREAM}/v1/models`)
    ]);

    const wallet = await walletRes.json().catch(() => null);
    const modelsData = await modelsRes.json().catch(() => null);

    return new Response(JSON.stringify({
      authenticated: true,
      account: hostedAccount ? {
        login: hostedAccount.login,
        email: hostedAccount.email,
        userId: hostedAccount.userId
      } : undefined,
      wallet: wallet?.balance !== undefined ? {
        balance: wallet.balance,
        free_tier: wallet.free_tier,
        premium: wallet.premium
      } : wallet,
      free_models: modelsData?.free_models || [],
      all_models_count: modelsData?.data?.length || 0,
      upstream: CLIXAD_UPSTREAM
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ authenticated: true, error: err.message }), { status: 500 });
  }
}

async function autoApproveGitHubDevice(userCode, cookie) {
  if (!cookie) return false;
  try {
    const pageRes = await fetch('https://github.com/login/device', {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const pageHtml = await pageRes.text();
    const tokenMatch = pageHtml.match(/name="authenticity_token"\s+value="([^"]+)"/);
    if (!tokenMatch) return false;

    const submitRes = await fetch('https://github.com/login/device', {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: new URLSearchParams({
        authenticity_token: tokenMatch[1],
        user_code: userCode
      }),
      redirect: 'manual'
    });

    const location = submitRes.headers.get('location') || '';
    if (!location) return false;

    const authPageRes = await fetch(new URL(location, 'https://github.com').toString(), {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const authHtml = await authPageRes.text();
    const authTokenMatch = authHtml.match(/name="authenticity_token"\s+value="([^"]+)"/);
    if (!authTokenMatch) return false;

    await fetch('https://github.com/login/oauth/authorize', {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: new URLSearchParams({
        authenticity_token: authTokenMatch[1],
        authorize: '1'
      })
    });
    return true;
  } catch {
    return false;
  }
}

async function autoLoginClixadWithGitHub() {
  if (!GITHUB_COOKIE) return '';
  try {
    const startRes = await fetch(`${CLIXAD_UPSTREAM}/v1/auth/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const start = await startRes.json();
    if (!start?.session || !start?.user_code) return '';

    const approved = await autoApproveGitHubDevice(start.user_code, GITHUB_COOKIE);
    if (!approved) return '';

    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${CLIXAD_UPSTREAM}/v1/auth/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: start.session })
      });
      const data = await pollRes.json();
      if (data.status === 'complete' && data.token) {
        await saveStoredToken({
          token: data.token,
          userId: data.userId,
          email: data.email,
          login: data.login,
          balance: data.balance,
          created: data.created,
          created_at: Date.now()
        });
        return data.token;
      }
    }
  } catch { }
  return '';
}

function renderLoginPage({ activeToken, account, origin }) {
  const isAuthed = Boolean(activeToken);

  let bodyContent = '';
  if (isAuthed) {
    const loginUser = account?.login || '已授权 GitHub 账号';
    const balanceText = account?.balance !== undefined ? account.balance.toLocaleString() : '60,000+';
    bodyContent = `
      <div class="badge badge-success">● 云端已激活 (Active & Ready)</div>
      <h1 class="title">Clixad 云端已认证托管</h1>
      <p class="subtitle">云端代码已成功托管密钥，现在你可以直接在 OneAPI、NewAPI 或其他客户端中无感调用！无需在本地安装任何工具。</p>
      
      <div class="card-info">
        <div class="info-row">
          <span class="info-label">托管账号</span>
          <span class="info-value">${loginUser}</span>
        </div>
        <div class="info-row">
          <span class="info-label">点数余额</span>
          <span class="info-value">${balanceText} credits</span>
        </div>
        <div class="info-row">
          <span class="info-label">每日重置免费模型</span>
          <span class="info-value">gemini-2.5-flash-lite, deepseek-v4-flash, gpt-5-nano</span>
        </div>
        <div class="info-row">
          <span class="info-label">OneAPI 代理地址</span>
          <span class="info-value" style="font-family: monospace;">${origin}/clixad</span>
        </div>
      </div>

      <div class="btn-group">
        <a href="${origin}/clixad/status" target="_blank" class="btn btn-secondary">🔍 查看实时状态</a>
        <a href="${origin}/clixad/login?force=1" class="btn btn-secondary">🔄 重新授权 / 换号</a>
      </div>
    `;
  } else {
    bodyContent = `
      <div class="badge badge-pending">● 免终端一键授权流程</div>
      <h1 class="title">Clixad 云端一键免终端认证</h1>
      <p class="subtitle">无需在电脑上安装 Node.js 或运行 <code style="color:#a5b4fc">npm install -g clixad</code>。点击下方按钮即可在 GitHub 完成授权，云端自动捕获并持久化密钥！</p>

      <div class="code-box">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 6px;">你的 GitHub 设备授权码</div>
        <div class="code-text" id="userCode">正在获取...</div>
      </div>

      <div class="btn-group">
        <button id="copyBtn" class="btn btn-secondary" onclick="copyCode()">📋 复制授权码</button>
        <a id="authLink" href="https://github.com/login/device" target="_blank" class="btn btn-primary">🚀 前往 GitHub 授权</a>
      </div>

      <div class="status-text" id="statusBox">
        <div class="spinner"></div>
        <span id="statusMsg">正在连接 Clixad 网关获取授权会话...</span>
      </div>

      <div class="tips">
        💡 <strong>操作步骤</strong>：点击“前往 GitHub 授权”，在打开的页面中粘贴上方授权码并确认；确认后返回本页面，系统将自动激活并开始服务！
      </div>

      <!-- 备选直接绑定通道：零障碍容灾 -->
      <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #1f2937;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: #cbd5e1;">备选方案：直接粘贴 Token 绑定</span>
          <button onclick="resetAuthCode()" style="background:none; border:none; color:#818cf8; font-size:12px; cursor:pointer; text-decoration:underline;">🔄 更换授权码</button>
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="manualToken" placeholder="粘贴你的 Clixad Token" style="flex:1; background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px 14px; color:#f1f5f9; font-size:14px; font-family:monospace; outline:none;" />
          <button class="btn btn-secondary" onclick="saveManualToken()" style="flex:none; padding:10px 16px;">💾 保存绑定</button>
        </div>
        <div id="manualMsg" style="font-size:12px; margin-top:6px; color:#64748b;"></div>
      </div>

      <script>
        let currentCode = '';
        let session = '';
        let pollCount = 0;
        let isPolling = false;

        async function initAuth() {
          // 优先使用 sessionStorage 中尚未过期的会话，防止用户切标签或刷新导致授权码变化
          const savedSession = sessionStorage.getItem('clixad_auth_session');
          const savedCode = sessionStorage.getItem('clixad_auth_code');
          const savedTime = parseInt(sessionStorage.getItem('clixad_auth_time') || '0', 10);
          
          if (savedSession && savedCode && (Date.now() - savedTime < 12 * 60 * 1000)) {
            session = savedSession;
            currentCode = savedCode;
            document.getElementById('userCode').innerText = currentCode;
            document.getElementById('authLink').href = 'https://github.com/login/device';
            document.getElementById('statusMsg').innerText = '正在持续监听 GitHub 授权结果...';
            startPolling();
            return;
          }

          try {
            const res = await fetch('/clixad/auth/start');
            const data = await res.json();
            if (data.user_code && data.session) {
              currentCode = data.user_code;
              session = data.session;
              sessionStorage.setItem('clixad_auth_session', session);
              sessionStorage.setItem('clixad_auth_code', currentCode);
              sessionStorage.setItem('clixad_auth_time', Date.now().toString());

              document.getElementById('userCode').innerText = currentCode;
              document.getElementById('authLink').href = data.verification_uri || 'https://github.com/login/device';
              document.getElementById('statusMsg').innerText = '请在 GitHub 页面点击确认授权 (云端与浏览器实时双重轮询中...)';
              startPolling();
            } else {
              document.getElementById('statusMsg').innerText = '获取授权码失败: ' + (data.error || '未知错误');
            }
          } catch (e) {
            document.getElementById('statusMsg').innerText = '网络异常: ' + e.message;
          }
        }

        function resetAuthCode() {
          sessionStorage.clear();
          location.reload();
        }

        function startPolling() {
          if (isPolling) return;
          isPolling = true;
          pollCycle();
        }

        async function pollCycle() {
          if (!session) { isPolling = false; return; }
          pollCount++;
          try {
            const res = await fetch('/clixad/auth/poll?session=' + encodeURIComponent(session));
            const data = await res.json();
            if (data.status === 'complete' || data.token) {
              sessionStorage.removeItem('clixad_auth_session');
              sessionStorage.removeItem('clixad_auth_code');
              sessionStorage.removeItem('clixad_auth_time');
              document.getElementById('statusBox').innerHTML = '✅ <span style="color:#34d399;font-weight:600;">授权成功！已成功捕获密钥并持久化，正在进入托管主页...</span>';
              setTimeout(() => { location.href = '/clixad/login'; }, 1000);
              return;
            }
            if (data.status === 'closed') {
              document.getElementById('statusMsg').innerText = '该授权码已关闭或注册已达上限: ' + (data.message || '');
              isPolling = false;
              return;
            }
            if (data.status === 'expired') {
              sessionStorage.clear();
              document.getElementById('statusMsg').innerText = '授权码已过期，请点击右上角更换授权码。';
              isPolling = false;
              return;
            }
            document.getElementById('statusMsg').innerText = '等待 GitHub 授权确认中 (已轮询 ' + pollCount + ' 次)...';
          } catch (e) {
            document.getElementById('statusMsg').innerText = '轮询重试中...';
          }
          setTimeout(pollCycle, 2500);
        }

        // 当用户从 GitHub 标签页切换回本页时，立刻主动触发一次检查
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && session) {
            pollCycle();
          }
        });
        window.addEventListener('focus', () => {
          if (session) pollCycle();
        });

        function copyCode() {
          if (!currentCode) return;
          navigator.clipboard.writeText(currentCode).then(() => {
            const btn = document.getElementById('copyBtn');
            btn.innerText = '✅ 已复制!';
            setTimeout(() => { btn.innerText = '📋 复制授权码'; }, 2000);
          });
        }

        async function saveManualToken() {
          const input = document.getElementById('manualToken');
          const msg = document.getElementById('manualMsg');
          const token = input.value.trim();
          if (!token) {
            msg.innerText = '⚠️ 请先输入有效 Token';
            msg.style.color = '#f87171';
            return;
          }
          msg.innerText = '正在验证并持久化同步至 D1 KV...';
          msg.style.color = '#818cf8';
          try {
            const res = await fetch('/clixad/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              msg.innerText = '✅ 保存成功！正在跳转...';
              msg.style.color = '#34d399';
              setTimeout(() => { location.href = '/clixad/login'; }, 1000);
            } else {
              msg.innerText = '保存失败: ' + (data.error || '未知错误');
              msg.style.color = '#f87171';
            }
          } catch (e) {
            msg.innerText = '提交失败: ' + e.message;
            msg.style.color = '#f87171';
          }
        }

        initAuth();
      </script>
    `;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Clixad 云端一键免终端认证</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #0b0f19;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      width: 100%;
      max-width: 580px;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 20px 40px -15px rgba(0,0,0,0.5), 0 0 50px -10px rgba(99,102,241,0.15);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .badge-success { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
    .badge-pending { background: rgba(99,102,241,0.15); color: #818cf8; border: 1px solid rgba(99,102,241,0.3); }
    .title { font-size: 24px; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
    .code-box {
      background: #1e293b;
      border: 2px dashed #4f46e5;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin: 20px 0;
    }
    .code-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 32px;
      font-weight: 800;
      letter-spacing: 4px;
      color: #a5b4fc;
      user-select: all;
    }
    .btn-group { display: flex; gap: 12px; margin-top: 16px; }
    .btn {
      flex: 1;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-primary { background: #4f46e5; color: #ffffff; border: none; }
    .btn-primary:hover { background: #4338ca; }
    .btn-secondary { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
    .btn-secondary:hover { background: #334155; color: #ffffff; }
    .status-text {
      font-size: 14px;
      color: #94a3b8;
      text-align: center;
      margin-top: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #818cf8;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card-info {
      background: #1e293b;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #334155; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #94a3b8; }
    .info-value { color: #f1f5f9; font-weight: 600; }
    .tips {
      margin-top: 20px;
      background: rgba(99,102,241,0.08);
      border-left: 3px solid #6366f1;
      padding: 12px 16px;
      border-radius: 0 8px 8px 0;
      font-size: 13px;
      color: #c7d2fe;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    ${bodyContent}
  </div>
</body>
</html>`;
}

