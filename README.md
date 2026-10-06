# Privatemode & Multi-AI Relay Proxy (Railway & Vercel 双平台支持)

本项目是一个高并发、低延迟的通用 AI 中转网关，支持部署到 **Railway** 以及 **Vercel**。专为 **OneAPI / NewAPI / Claude Code / Cursor** 以及各类客户端打造，支持极速流式传输（SSE 打字机单字零延迟推送）。

---

## 📖 核心功能与理解

参考 [Privatemode 官方文档](https://docs.privatemode.ai/getting-started/api/)：
Privatemode 提供了机密计算（Confidential Computing）环境下的安全 AI 推理，支持模型包括 **GLM-5.3**、**GLM-5.3-Flash**、**glm-latest** 等。

本项目采用轻量 Node.js 原生服务器（`server.js`，无第三方依赖），支持 Web Streams 双向流式透传，完美适配 Railway 容器环境及 Vercel Edge Runtime。

---

## 接口路径规则

| 接口分类 | 本地/线上请求路径 | 转发上游目标 | 说明 |
| :--- | :--- | :--- | :--- |
| **Privatemode 专用接口** | `/privatemode/v1/*` 或 `/pm/v1/*` | `https://proxyless-api.privatemode.ai/v1/*` | 自动剥离前缀并转发至 Privatemode |
| **OpenAI 兼容通用接口** | `/v1/*` | `https://api.openai.com/v1/*` | 默认通用中转接口（可配置默认上游） |
| **自定义目标接口** | 任意路径（带 `x-target-url` 请求头） | 请求头指定的完整绝对 URL | 兼容 Cloudflare Worker / OneAPI 动态路由 |
| **健康探针** | `/healthz` | 本地返回 `{ "status": "ok" }` | 供 Railway 健康检查与保活探测 |

---

## 🚀 部署到 Railway 步骤

### 方式一：GitHub 自动关联部署（推荐）

1. 将本项目推送到你的 GitHub 仓库。
2. 登录 [Railway 控制台](https://railway.com/)。
3. 点击 **New Project** -> **Deploy from GitHub repo** -> 选择当前仓库。
4. Railway 会自动根据仓库内的 `railway.json` 与 `Dockerfile` 构建并启动服务。
5. **⚠️ 关键步骤（生成公网域名）**：
   - 部署完成后，点击服务进入详情。
   - 点击 **Settings** 标签页。
   - 找到 **Networking** -> **Public Networking**，点击 **Generate Domain**。
   - 你将获得一个公网 HTTPS 域名，例如：`https://xxx.up.railway.app`。
6. （可选）在 **Variables** 标签页中添加环境变量（如 `RELAY_SECRET` 或 `PRIVATEMODE_API_KEY`）。

### 方式二：使用 Railway CLI 命令行部署

```bash
# 1. 安装 Railway CLI
npm i -g @railway/cli

# 2. 登录并初始化
railway login
railway init

# 3. 上传并部署
railway up

# 4. 生成公网域名
railway domain
```

---

## 🌐 继续部署在 Vercel（同时兼容）

由于项目中保留了 `api/proxy.js` 及 `vercel.json`：
- 直接导入当前 GitHub 仓库到 Vercel 即可部署为 Serverless / Edge Function。
- 环境变量可在 Vercel Dashboard 中配置。

---

## ⚙️ 环境变量说明

| 变量名 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` (Railway 会自动分配) | 服务监听端口，无需在 Railway 手动配置 |
| `RELAY_SECRET` | *(空)* | 中转鉴权秘钥。若设置，客户端需在 `x-relay-secret` 或 `Authorization: Bearer <secret>` 验证 |
| `PRIVATEMODE_API_KEY` | *(空)* | 若配置，当客户端请求未携带 Key 或使用 `placeholder` 时自动填充 |
| `PRIVATEMODE_UPSTREAM`| `https://proxyless-api.privatemode.ai` | Privatemode 目标上游地址 |
| `DEFAULT_UPSTREAM` | `https://api.openai.com` | 默认通用接口的目标上游地址 |

---

## 🔌 在 OneAPI / NewAPI 中配置使用

在 OneAPI 添加渠道：
1. **类型**：`OpenAI`
2. **代理地址 (Base URL)**：
   - `https://your-service.up.railway.app/privatemode` （OneAPI 会自动拼接 `/v1/chat/completions`）
3. **密钥 (Key)**：你的 Privatemode API Key（若网关配置了 `RELAY_SECRET`，填入 `RELAY_SECRET` 即可）
4. **模型列表**：`glm-latest,glm-5.3,glm-5.3-flash,gpt-oss-120b`
