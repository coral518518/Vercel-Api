# Privatemode & Multi-AI Relay Proxy (Vercel & Fly.io 双平台支持)

本项目是一个高并发、低延迟的通用 AI 中转网关，支持部署到 **Vercel** 以及 **Fly.io**。专为 **OneAPI / NewAPI / Claude Code / Cursor** 以及各类客户端打造，支持极速流式传输（SSE 打字机单字零延迟推送）。

---

## 📖 核心功能与理解

参考 [Privatemode 官方文档](https://docs.privatemode.ai/getting-started/api/)：
Privatemode 提供了机密计算（Confidential Computing）环境下的安全 AI 推理，支持模型包括 **GLM-5.3**、**GLM-5.3-Flash**、**glm-latest** 等。

在实际使用中，通常有两种方式接入 Privatemode：
1. **Proxyless API（无代理直连端点）**：官方端点为 `https://proxyless-api.privatemode.ai/v1`，标准 OpenAI 兼容协议。
2. **Privatemode CVM Proxy（官方机密计算代理容器）**：镜像为 `ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest`，运行在端口 8080，负责客户端远程证明（Remote Attestation）与硬件级内存加密。
   *由于 Vercel 是 Serverless/Edge 架构，无法运行常驻的 Docker 容器与后台守护进程，因此将代理部署到 **Fly.io** 是最佳方案！*

本项目支持以下两种部署与使用方案：

---

## 方案一：部署多功能网关到 Fly.io / Vercel（推荐）

本项目代码包含原生轻量 Node.js 服务器（`server.js`），无任何冗余依赖，原生支持 Web Streams 双向流式转发。

### 1. 接口路径规则

| 接口分类 | 本地/线上请求路径 | 转发上游目标 | 说明 |
| :--- | :--- | :--- | :--- |
| **Privatemode 专用接口** | `/privatemode/v1/*` 或 `/pm/v1/*` | `https://proxyless-api.privatemode.ai/v1/*` | 自动剥离前缀并转发至 Privatemode |
| **OpenAI 兼容通用接口** | `/v1/*` | `https://api.openai.com/v1/*` | 默认通用中转接口（可配置默认上游） |
| **自定义目标接口** | 任意路径（带 `x-target-url` 请求头） | 请求头指定的完整绝对 URL | 兼容 Cloudflare Worker / OneAPI 动态路由 |
| **健康探针** | `/healthz` | 本地返回 `{ "status": "ok" }` | 供 Fly.io 健康检查与保活探测 |

### 2. 部署到 Fly.io 步骤

确保本机已安装 [flyctl](https://fly.io/docs/hands-on/install-flyctl/) 并已登录（`fly auth login`）：

```bash
# 1. 首次初始化应用（根据提示确认配置）
fly launch --no-deploy

# 2. 设置机密环境变量（可选，若需要在服务端统一鉴权或注入 Key）
fly secrets set RELAY_SECRET="your_custom_relay_secret"
fly secrets set PRIVATEMODE_API_KEY="your_privatemode_api_key"

# 3. 部署服务
fly deploy
```

部署成功后，你将获得一个全局 HTTPS 域名，例如：
`https://your-relay-app.fly.dev`

### 3. 继续部署在 Vercel（同时兼容）

由于保留了 `api/proxy.js` 及 Edge Runtime 配置，项目仍然支持在 Vercel 一键部署：
- 导入当前 GitHub 仓库到 Vercel 即可自动部署。
- 在 Vercel 环境变量中可配置 `RELAY_SECRET`、`PRIVATEMODE_API_KEY` 等。

---

## 方案二：直接在 Fly.io 部署官方机密计算代理容器

如果你希望直接运行 Privatemode 官方的硬件级证明代理容器（`ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest`），项目中已准备好专属配置文件 `fly.privatemode.toml`：

```bash
# 1. 部署官方代理容器
fly deploy -c fly.privatemode.toml

# 2. 设置 Privatemode API 密钥
fly secrets set PRIVATEMODE_API_KEY="your_privatemode_api_key" -c fly.privatemode.toml
```

部署完成后：
- Base URL 即为：`https://your-official-proxy.fly.dev/v1`
- 支持端点：`/v1/chat/completions`、`/v1/messages` (Claude)、`/v1/models`、`/v1/embeddings`。

---

## 环境变量说明

| 变量名 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` | Fly.io / 本地运行监听端口 |
| `RELAY_SECRET` | *(空)* | 中转鉴权秘钥。若设置，客户端需在 `x-relay-secret` 或 `Authorization: Bearer <secret>` 验证 |
| `PRIVATEMODE_API_KEY` | *(空)* | 若配置，当客户端请求未携带 Key 或使用 `placeholder` 时自动填充 |
| `PRIVATEMODE_UPSTREAM`| `https://proxyless-api.privatemode.ai` | Privatemode 目标上游地址 |
| `DEFAULT_UPSTREAM` | `https://api.openai.com` | 默认通用接口的目标上游地址 |

---

## 在 OneAPI / NewAPI 中配置使用

在 OneAPI 添加渠道：
1. **类型**：`OpenAI`
2. **代理地址 (Base URL)**：
   - 使用多接口网关：`https://your-relay-app.fly.dev/privatemode` （OneAPI 会自动拼接 `/v1/chat/completions`）
   - 使用官方代理容器：`https://your-official-proxy.fly.dev`
3. **密钥 (Key)**：你的 Privatemode API Key（若网关配置了 `RELAY_SECRET`，填入 `RELAY_SECRET` 即可）
4. **模型列表**：`glm-latest,glm-5.3,glm-5.3-flash,gpt-oss-120b`
