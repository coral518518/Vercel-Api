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
| **Clixad 专用接口** | `/clixad/v1/*` 或 `/cx/v1/*` | `https://clixad.onrender.com/v1/*` | 自动剥离前缀并转发至 Clixad (每日免费模型 + 进阶模型) |
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
| `CLIXAD_API_KEY` / `CLIXAD_TOKEN` | *(空)* | Clixad 账号 Token。若配置，客户端使用 `placeholder` 或 `RELAY_SECRET` 时自动填充 |
| `CLIXAD_UPSTREAM` | `https://clixad.onrender.com` | Clixad 官方网关上游地址（亦可根据需要配置为自定义网关） |
| `CLIXAD_KV_SELECT_URL` | `https://d1.coral001.de5.net/common_data/kvselect/clixad` | D1 KV 查询端点，用于获取并追加已有秘钥池 |
| `CLIXAD_KV_ADD_URL` | `https://d1.coral001.de5.net/common_data/kvadd/clixad` | D1 KV 写入端点，授权获取到新秘钥后自动追加并 POST 提交持久化 |
| `DEFAULT_UPSTREAM` | `https://api.openai.com` | 默认通用接口的目标上游地址 |

---

## 🔌 在 OneAPI / NewAPI 中配置使用

### 1. Privatemode 渠道配置
1. **类型**：`OpenAI`
2. **代理地址 (Base URL)**：`https://your-service.up.railway.app/privatemode` （自动拼接 `/v1/chat/completions`）
3. **密钥 (Key)**：你的 Privatemode API Key（若配置了 `RELAY_SECRET`，填入 `RELAY_SECRET` 即可）
4. **模型列表**：`glm-latest,glm-5.3,glm-5.3-flash,gpt-oss-120b`

### 2. Clixad 渠道配置 (https://clixad.io)

> **💡 云端免终端一键认证（无需在本地安装任何 npm 工具或运行终端命令）**：
> 1. 打开浏览器访问：`https://your-service.up.railway.app/clixad/login`
> 2. 点击页面上的 **【前往 GitHub 授权】** 并在 GitHub 确认（仅需 2 秒）。
> 3. 云端代码将**全自动捕获 Token、持久化保存到服务器，并自动处理每日签到**！
> 4. 此后，OneAPI 发来的所有请求都将由云端自动注入 Token 进行中转！

在 OneAPI 添加渠道：
1. **类型**：`OpenAI`
2. **代理地址 (Base URL)**：`https://your-service.up.railway.app/clixad`（亦支持 `/cx`）
3. **密钥 (Key)**：**留空或填任意占位符**（如 `sk-clixad`，若网关配置了 `RELAY_SECRET` 则填 `RELAY_SECRET`）
4. **模型列表**：
   - **每日免费模型 (Free Models)**：`gpt-5-nano,gemini-2.5-flash-lite,deepseek-v4-flash,gemini-3.5-flash-lite,kimi-k2.5`
   - **进阶与高级模型**：`gemini-3.8-flash,kimi-k2.7-code,claude-haiku-4.5,claude-sonnet-5.5,gpt-6-sol,kimi-k3,claude-opus-5.5,claude-fable-5.1`
5. **获取模型**：支持直接在 OneAPI 中点击“获取模型列表”，网关会自动转发至 Clixad `/v1/models` 获取最新支持的模型。
6. **健康与状态查询**：访问 `https://your-service.up.railway.app/clixad/status` 可查看当前托管账号点数、免费额度与连通性。

### 3. 可选：全自动静默认证配置
若希望**完全无需任何人工点击**，可在 Railway 环境变量中配置：
* `GITHUB_COOKIE`：填写你的 GitHub 登录 Cookie（`user_session=...`）。云端代码将在检测到未认证时全自动后台调用 GitHub 完成设备授权，实现 0 点击全自动静默认证与刷新。

