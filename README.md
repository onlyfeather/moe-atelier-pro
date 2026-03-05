# 萌图工坊（moe-atelier-pro）

一个方便 **nano banana pro** 跑图的小工具。前端通过 OpenAI 兼容接口发起请求，自动从响应中解析 base64/URL 图片并展示。支持多用户登录与管理员全局配置。

## 项目说明
本项目在原项目 **FSHebe233/moe-atelier** 的基础上进行体系化增强，保持原有轻量易用体验的同时，补齐多用户、管理员与服务端持久化能力，面向小规模部署与协作场景。

## 原项目
原项目地址（GitHub）：
```
https://github.com/FSHebe233/moe-atelier
```

## 改进点（相对原项目）
| 类别 | 改进内容 |
|---|---|
| 多用户体系 | 引入本地账号 + 密码 + 验证码登录，区分管理员与普通用户 |
| 管理员能力 | 管理员统一配置 API 与模型白名单；支持查看用户任务与原图并下载 |
| 服务端持久化 | 使用 SQLite 持久化用户、任务、配置、模型缓存、收藏与图片 |
| 模型治理 | 自动获取模型列表并同步至白名单，用户仅可从白名单选择 |
| 默认后端模式 | 前端默认后端模式，任务/配置/收藏通过服务端同步 |
| 部署体验 | 提供 Docker 部署与持久化目录挂载方案，便于快速上线 |

## 功能特性
- 支持 OpenAI 兼容接口（`/v1` + `chat/completions`），解析 `data[0].b64_json` / `data[0].url` / Markdown 图片（含流式）。
- 多任务并发 + 任务拖拽排序 + 自动重试/暂停/继续 + 单任务与全局统计。
- 支持上传参考图（多模态输入），后端模式下自动缓存。
- 内置「提示词广场」：默认拉取 nanobanana-website 数据源，支持自定义 URL、标签筛选、收藏。
- 多用户登录（本地账号 + 验证码），管理员全局配置 API 与模型白名单。
- 管理员可查看用户任务与原图，并支持下载。
- 图片缓存与任务状态保存在服务器端数据库（SQLite）。

## 技术栈
- React + Vite + Ant Design
- Express（本地开发/生产一体服务）

## 快速开始
```bash
npm install
npm run dev
```
浏览器访问 `http://localhost:5173`。

首次启动会自动创建管理员账号（来自环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD`），用该账号登录后在「管理员控制台」配置 API。

## 生产构建与运行
```bash
npm run build
npm run preview
# 或
npm run start
```

## Docker（可选）
```bash
docker build -t moe-atelier-pro .
docker run --rm -p 5173:5173 -v ${PWD}/saved-images:/app/saved-images -v ${PWD}/server-data:/app/server-data moe-atelier-pro
```
或使用 `docker-compose`：
```bash
docker compose up --build
```
`docker-compose` 已包含 `server-data/` 挂载；使用 `docker run` 时也请挂载该目录以持久化数据。

## 部署到服务器（推荐流程）
| 步骤 | 说明 |
|---|---|
| 1 | 上传项目到服务器 |
| 2 | 修改 `docker-compose.yml` 中的 `SESSION_SECRET`、`ADMIN_PASSWORD` |
| 3 | 运行 `docker compose up -d --build` |
| 4 | 访问 `http://服务器IP:5173` |

## 上传项目到服务器
| 方式 | 命令示例 |
|---|---|
| Git | `git clone <仓库地址> moe-atelier-pro` |
| SCP | `scp -r ./moe-atelier-pro user@server:/opt/` |
| rsync | `rsync -av ./moe-atelier-pro user@server:/opt/` |

## 配置说明（前端面板）
- **API 接口地址**：默认 `https://api.openai.com/v1`。使用其他兼容服务时，填写其 `/v1` 基础地址。
- **API Key**：你的密钥。
- **模型白名单**：管理员可自动获取并写入白名单。
- **流式开关**：开启后会解析流式文本中的 Markdown 图片链接。
- **提示词数据源**：在「提示词广场」里可切换为自定义 URL。

## 多用户与管理员
| 功能 | 说明 |
|---|---|
| 登录方式 | 本地账号 + 密码 + 验证码 |
| 管理员 | 通过环境变量初始化账号，登录后配置全局 API |
| 用户 | 仅选择模型与使用功能，不配置 API |

后端数据存放在 `server-data/`（SQLite + 图片缓存）。请妥善保管服务器与管理员账号。

## 环境变量
| 变量 | 说明 |
|---|---|
| `SESSION_SECRET` | Session 加密密钥（生产必须设置） |
| `SESSION_TTL` | Session 过期时间（秒） |
| `ADMIN_USERNAME` | 启动时自动创建的管理员账号 |
| `ADMIN_PASSWORD` | 启动时自动创建的管理员密码 |
| `BACKEND_LOG_REQUESTS` | 打印请求日志（`1/true/yes` 开启） |
| `BACKEND_LOG_OUTBOUND` | 打印后端到模型服务的请求日志 |
| `BACKEND_LOG_RESPONSE` | 打印模型响应（会截断长内容） |
| `PORT` | 服务监听端口，默认 `5173` |
| `VITE_HOST` | 开发模式下的 Vite Host，外网访问可设 `0.0.0.0` |

## 公网访问
### 开发模式（Vite）
需要监听公网地址（`0.0.0.0`）：
```powershell
$env:VITE_HOST="0.0.0.0"
npm run dev
```
或：
```bash
VITE_HOST=0.0.0.0 npm run dev
```
然后放通端口（默认 5173）。

### 生产模式（Express）
默认端口 `5173`，可通过 `PORT` 指定：
```powershell
$env:PORT="8080"
npm run start
```
或：
```bash
PORT=8080 npm run start
```
如果用 Nginx/Caddy 反代到公网，请保证 HTTPS（因为要在浏览器里填写 API Key），并确保你的 OpenAI 兼容服务允许跨域访问。

## 目录结构
- `src/`：前端源码
- `server.mjs`：本地服务（开发中挂载 Vite，生产提供静态资源与 `/api/save-image`）
- `server-data/`：SQLite 与后端数据
- `dist/`：构建产物
- `saved-images/`：本地保存图片目录（自动创建）

## 注意事项
- 仅支持 OpenAI 兼容格式；响应中需包含 base64 或图片 URL。
- 如果只部署静态 `dist/` 而不跑 `server.mjs`，保存图片到 `saved-images/` 与多用户功能不可用。
- 服务器会保存配置与 API Key，请注意安全。

## 致谢
感谢原项目 **FSHebe233/moe-atelier** 的作者与社区贡献，为本项目提供了坚实基础。
感谢 [nanobanana-website](https://github.com/unknowlei/nanobanana-website) 提供的数据源支持。
