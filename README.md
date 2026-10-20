# 邻里充电运营平台

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hvirgo0724-code/neighbor-charge-platform)

面向多社区、多组织的社区充电运营工作台：统一管理社区、充电桩、预约、订单、设备事件、维修工单、审批和运营报表，并通过带风险门的 Agent 工作台把自然语言查询、故障归因和高风险动作串成可追溯的闭环。

前端为原生 HTML / CSS / JavaScript（无构建步骤、无第三方 UI 库），后端为 FastAPI。默认使用零依赖的演示模式：首次启动自动写入种子数据，数据持久化到本地 JSON 文件，因此**不需要 MySQL、PostgreSQL 或 Redis 也能完整运行**。FastAPI 可直接运行在 Docker / Render，Netlify 预览则使用同 API 契约的 JavaScript 适配器。

## 快速开始

要求 Python 3.11+。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

打开 <http://127.0.0.1:8000/>。API 文档在 <http://127.0.0.1:8000/docs>，健康检查为 `/api/health`。

首次启动会生成 `.data/store.json`。想恢复初始演示数据，停止服务后删除该文件再启动即可。

## 演示账号

所有演示账号密码均为 `admin123`，登录页可点击账号一键进入。

| 账号 | 姓名 | 角色 | 典型视图 |
|---|---|---|---|
| `admin` | 系统管理员 | 管理员 | 全部社区、用户与权限、审计日志 |
| `operator` | 李静 | 运营人员 | 阳光花园 / 枫林雅苑的设备、订单、工单、审批 |
| `repairer` | 王强 | 维修人员 | 设备、工单接单 / 回填 / 验收 |
| `finance` | 赵敏 | 财务审批 | 审批中心、订单、运营报表 |
| `user` | 陈晨 | 居民用户 | 本人预约、订单、退款申请与社区设备 |

`cloudadmin`（云栖管理员，密码同样为 `admin123`）属于另一个租户，用于验证租户隔离，不出现在演示账号列表中。

## 已实现能力

### 身份、权限与数据范围

- 登录、刷新令牌、退出登录；PBKDF2-HMAC-SHA256 密码哈希，服务端签发 HMAC-SHA256 令牌。
- 管理员 / 运营 / 维修 / 财务 / 居民五类角色，菜单按角色隐藏，**接口再次做 RBAC 校验**。
- 租户隔离 + 社区授权 + 本人数据范围三层校验；普通用户只能读取本人订单和申请。
- 登录失败限流（5 分钟窗口），登录失败、权限拒绝、退出均写入审计。

### 设备与事件

- 社区、充电桩台账，实时状态：可用 / 充电中 / 已预约 / 故障 / 离线 / 维护。
- `POST /api/device-events` 接入心跳、功率、电流、温度、离线、故障、充电中断、恢复事件。
- 事件按 `event_id` 幂等去重；故障、离线、充电中断、温度 ≥ 65°C 自动创建工单，重复异常会升级为 P1 并追加时间线，不重复建单。
- 设备详情提供遥测、最近事件、未关闭工单和模拟事件入口。

### 预约与订单

- 查询可用桩、按时段预约、取消预约；预约窗口 30 分钟至 4 小时，最多提前 7 天。
- 同一枪口时间冲突返回 `409 RESERVATION_CONFLICT` 并附带冲突订单号；支持 `Idempotency-Key`。
- 订单状态：已预约 → 充电中 → 已完成 / 已退款 / 已取消；开始、完成、取消、退款全链路审计。
- 用户只能操作本人订单；运营只能操作授权社区订单；退款不直接执行，创建审批申请。

### 工单与验收

- 工单状态：待处理 → 已分派 → 处理中 → 待验收 → 已关闭。
- 分派、接单、维修回填、创建测试订单、模拟心跳、验收关闭。
- **关闭前强制校验**：设备心跳在 10 分钟内、存在该工单的已完成测试订单、维修回填非空；不满足时返回 `409 TICKET_VERIFICATION_FAILED` 并列出缺失项。
- P1/P2/P3 分级和 SLA 时限，超时标识与看板。

### 审批与财务

- 审批类型：退款、停机、调价、批量改派。
- 审批流程：申请 → 风险因素与影响范围展示 → 管理员 / 财务决策 → 执行回执 → 审计。
- 申请人与审批人不能是同一人；已处理审批不可重复决策；执行失败会保留 `failed` 状态和原因。
- 退款只改订单退款金额，不删除流水；停机创建检修工单；调价批量更新授权社区设备电价。
- 审批中心支持按状态、类型筛选，CSV 导出运营报表。

### Agent 工作台

Agent 是本地确定性工具编排，不依赖外部 LLM，因此离线可运行、结果可复现。节点与文档中的 LangGraph 工作流一一对应：

```text
parse_intent → load_context → check_permission → plan_action → risk_gate
   ├─ 只读：execute_action → verify_result → write_memory → reflect
   └─ 高风险：request_approval →（人工审批）→ 执行 → 回执
```

- 只读工具：可用设备、故障归因、订单 / 收入、工单、待审批、指标解释、电价。
- 普通写：在授权范围内创建维修工单（中风险）。
- 高风险：退款、停机、调价、批量改派只创建审批申请，回答中明确“尚未执行任何变更”，并返回 `approval_id`。
- 每次回答返回 `intent`、`risk`、`status`、`data_sources`、`nodes`、`trace_id`、`thread_id`，前端展示执行轨迹和数据来源。
- 居民用户询问停机 / 调价会被直接拦截；Agent 查询严格复用登录人的数据范围。

### 报表

- 首页：设备可用率、今日订单、今日净收入、未关闭工单、待审批、在线设备、7 天趋势、告警、社区健康度、最近审计动态。
- 运营报表：净收入、完成订单、可用率、利用率、故障率、MTTR、预约成功率、退款金额、社区对比、工单等级分布、高故障设备、7/30 天切换与 CSV 导出。
- 测试订单（`is_test=true`）不计入收入；退款从净收入中扣减。

## 验收标准对照

| 文档验收项 | 实现位置 | 自动化测试 |
|---|---|---|
| 登录后只看到角色允许的菜单 | 前端 `PAGES` 角色过滤 + 后端 `require_roles` | `test_rbac_and_user_order_isolation` |
| 普通用户无法读取他人订单 | `_orders_for` + `_ensure_order_scope` | 同上、`test_tenant_isolation` |
| 重复设备事件不重复建单 | `event_id` 幂等 + 开单去重 | `test_device_event_idempotency_and_escalation` |
| 高风险 Agent 请求生成审批而不执行 | `_high_risk` / `create_approval` | `test_agent_refund_creates_approval_not_execution` |
| 工单关闭必须完成验收 | `ticket_verification` + `close_ticket` | `test_ticket_close_requires_heartbeat_and_test_order` |
| 数据库故障返回可识别错误并记日志 | 原子写失败回滚 + `503 STORE_UNAVAILABLE` + JSON 日志 | `test_storage_failure_is_identifiable` |
| 预约冲突 / 订单幂等 / 审批拦截 | 领域服务事务 | 16+ 项测试 |

## 项目结构

```text
app/
├── main.py                 # FastAPI 入口、中间件、异常处理、静态资源
├── config.py               # 环境配置与 .env 读取
├── core.py                 # 时间、trace_id、脱敏、统计工具
├── passwords.py            # PBKDF2 密码哈希
├── security.py             # 令牌、RBAC、数据范围、登录限流
├── errors.py               # 稳定错误码
├── schemas.py              # Pydantic 请求模型（拒绝未知字段）
├── store.py                # JSON 事务仓库（原子替换 / 回滚）
├── seed.py                 # 确定性演示数据
├── services.py             # 预约、订单、事件、工单、审批、报表领域服务
├── agent.py                # Agent 工具编排与风险门
├── audit.py                # 审计写入与脱敏
├── logging_config.py       # 结构化 JSON 日志
└── routers/                # auth / console / operations / reports / agent
static/
├── index.html              # 单页工作台
└── assets/
    ├── styles.css          # 原生设计系统
    ├── favicon.svg
    └── js/{app,api,ui}.js  # 原生 ES Module
netlify/functions/api/      # Netlify 演示适配器（JavaScript，内存状态）
scripts/export_seed.py      # 构建时导出与 FastAPI 相同的种子数据
tests/                      # pytest 验收测试
docs/                       # 五份需求 / 架构 / 开发 / 部署 / 安全文档 + 演示指南
database/                   # 生产 MySQL/PostgreSQL schema 参考（演示模式不连接）
```

## 主要 API

所有受保护接口使用 `Authorization: Bearer <token>`；写接口支持 `Idempotency-Key`；响应头带 `X-Trace-Id`。

```text
POST /api/auth/login              POST /api/auth/refresh         POST /api/auth/logout
GET  /api/auth/me                 GET  /api/auth/demo-accounts
GET  /api/dashboard               GET  /api/reports/operations?days=7
GET  /api/reports/operations.csv  GET  /api/meta                  GET  /api/health
GET  /api/communities             POST /api/communities
GET  /api/piles                   GET  /api/piles/{id}           POST /api/piles
GET  /api/orders                  GET  /api/orders/{id}
POST /api/orders/{id}/start       POST /api/orders/{id}/complete
POST /api/orders/{id}/cancel      POST /api/refunds
GET  /api/reservations            POST /api/reservations         DELETE /api/reservations/{id}
POST /api/device-events           GET  /api/events
GET  /api/tickets                 GET  /api/tickets/{id}         POST /api/tickets
POST /api/tickets/{id}/assign     POST /api/tickets/{id}/accept
POST /api/tickets/{id}/resolve    POST /api/tickets/{id}/test-order
POST /api/tickets/{id}/heartbeat  POST /api/tickets/{id}/close
GET  /api/approvals               GET  /api/approvals/{id}       POST /api/approvals
POST /api/approvals/{id}/decision
POST /api/agent/chat              GET  /api/agent/threads        GET  /api/agent/policy
GET  /api/users                   POST /api/users                PATCH /api/users/{id}/status
GET  /api/audit
```

## 测试

```powershell
pip install -r requirements-dev.txt
pytest -q
python -m compileall app
```

覆盖：健康检查、登录 / 令牌、RBAC、租户隔离、用户订单隔离、预约冲突、预约校验、订单生命周期、设备事件幂等与升级、工单验收关闭、Agent 只读查询、Agent 退款审批、Agent 停机审批、自审批禁止、参数校验、报表与审计、存储故障 503。

## 部署真实 FastAPI（Render）

Netlify 不能运行 FastAPI。要部署**真正的 FastAPI 后端**，仓库已经准备好 Render Blueprint（`render.yaml` + `Dockerfile`），推荐使用 Render：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hvirgo0724-code/neighbor-charge-platform)

1. 点击上方 **Deploy to Render** 按钮。
2. 登录 Render（可用 GitHub 账号），确认 `neighbor-charge-api` Web Service。
3. Render 会基于 `Dockerfile` 构建镜像，启动 `uvicorn`，健康检查为 `/api/health`。
4. 部署完成后访问 Render 提供的 `https://<service>.onrender.com`，FastAPI 会同时提供 API 和 `static/` 前端。

也可以在 Render Dashboard 中手动操作：**New → Blueprint → 选择 GitHub 仓库 `hvirgo0724-code/neighbor-charge-platform`**，Render 会自动读取 `render.yaml`。

说明：

- 免费 Web Service 的文件系统是临时的，`DATA_FILE=/tmp/neighbor-charge-store.json`，实例重启会回到种子数据；需要持久化时给服务挂载 Render Disk 并把 `DATA_FILE` 指向挂载目录，或接入 PostgreSQL。
- Render 会自动注入 `PORT` 和随机的 `JWT_SECRET`；不需要手动配置密钥。
- 如果服务暂时没有访问，Render 免费实例会休眠，首次请求需要几十秒唤醒。
- 同样的 Dockerfile 也可以部署到 Fly.io、Railway、Koyeb 或任意 VPS。

## 一键部署到 Netlify（前端预览）

Netlify Functions 官方文档只提供 JavaScript / TypeScript 与 Go 运行时，不能直接运行 FastAPI。因此仓库采用双实现：

- **本地 / Docker / 生产**：FastAPI 后端（`app/` + `uvicorn`）。
- **Netlify 一键预览**：同一套原生前端 + `netlify/functions/api/api.mjs` 内存适配器；构建时从 `app/seed.py` 导出同一份 `seed.json`，接口契约与 FastAPI 保持一致。

部署步骤：

1. 将仓库推送到 GitHub / GitLab。
2. 在 Netlify 选择 **Add new site → Import an existing project**，选择该仓库。
3. 构建配置会自动读取 `netlify.toml`：
   - publish：`static`
   - functions：`netlify/functions`
   - build：`python scripts/export_seed.py`
4. Deploy。静态工作台由 Netlify CDN 提供，`/api/*` 重写到 `/.netlify/functions/api/:splat`。

说明：

- Netlify 适配器是**演示运行时**：数据保存在函数实例内存中，冷启动 / 实例回收后回到种子数据；多实例之间不共享状态。
- 真实业务部署请使用 FastAPI + 共享数据库（MySQL / PostgreSQL），或把 Netlify 前端指向独立部署的 FastAPI 服务。
- `netlify.toml` 中的构建命令只依赖 Python 标准库，不需要在 Netlify 上安装 FastAPI。
- 如需修改演示数据，编辑 `app/seed.py` 后重新构建，`scripts/export_seed.py` 会同步给 Netlify 适配器。

## Docker

```powershell
docker compose up --build
```

访问 <http://127.0.0.1:8000/>。数据保存在 `neighbor_data` 卷中，容器重启不丢失。

## 数据与可靠性

- 默认存储为 `.data/store.json`，每次写操作在锁内完成，先备份内存快照，再写临时文件、`fsync`、原子替换。
- 写入失败会回滚内存并返回 `503 STORE_UNAVAILABLE`，同时写结构化错误日志。
- 事件、预约、审批使用幂等键或业务唯一键；预约冲突和订单状态机在事务内校验。
- 所有写操作与业务状态变更都要经过审计；审计日志最多保留 1200 条，避免演示文件无限增长。

## 安全基线

- 密码不明文存储；令牌带签名、过期时间、jti，退出即撤销。
- 敏感字段（手机号、邮箱、身份证、密码 / token 字样）在审计和 Agent 记忆中脱敏。
- 所有查询先校验租户、社区、本人范围；前端菜单隐藏只是体验优化。
- 请求模型禁止未知字段；高风险动作只创建审批。
- 生产部署务必：设置随机 `JWT_SECRET`、启用 HTTPS、限制 CORS 来源、关闭 `/docs`、替换演示账号与种子数据、接入真实数据库与集中式日志。

## 与五份文档的关系

- 需求 / 架构 / 开发 / 部署 / 安全文档保留在 `docs/`，是产品与生产基线。
- 本交付优先保证“开箱即运行 + 可一键部署”：采用文档中的 `DEMO_MODE` 思路，以 JSON 存储替代 MySQL / PostgreSQL / Redis，避免本地必须启动中间件。
- 生产化时可按 `app/store.py` 的仓储边界替换为 MySQL（身份）、PostgreSQL/pgvector（业务与记忆）和 Redis（缓存 / 队列）；领域服务、API 契约、Agent 工具白名单和审批门可以直接复用。

## 已知边界

- 演示模式为单进程内存 + JSON 文件；多实例部署需要换成共享数据库。
- Agent 使用规则 + 受控工具编排，不调用外部 LLM，保证离线可复现；接入模型时只需替换回答生成层，风险门与审批流程不变。
- 未实现短信 / 支付渠道 / 真实设备协议，设备事件通过 HTTP 模拟接入。
