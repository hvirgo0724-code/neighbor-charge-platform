# 数据库参考脚本（非演示必需）

本目录的 MySQL / PostgreSQL 脚本来自 `docs/02` 的生产拓扑设计，用于说明租户、身份、设备、订单、工单、审批和记忆表的生产落库方式。

当前可运行交付默认使用 `DEMO_MODE=true` 和 `app/store.py` 的原子 JSON 持久化，**不会连接 MySQL/PostgreSQL**，因此本地启动与 Netlify 预览无需执行这些脚本。接入生产数据库时，应以 `app/services.py` 的领域契约为准重新校对表结构、迁移和索引，不要把这里的种子 SQL 直接用于生产。
