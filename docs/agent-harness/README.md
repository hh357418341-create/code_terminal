# Agent Harness

这套 harness 是给 Codex / subagent / 后续自动化开发代理读取的仓库级上下文入口。它把长期稳定的规则、记忆变量、技能路由和分工模板放在固定位置，避免每次重新从聊天记录里恢复。

## Load Order

1. 先读根目录 `AGENTS.md`，它仍然是最高优先级的仓库规则。
2. 需要执行开发任务时读 `rules.md`，确认修改、验证、提交、部署边界。
3. 再读本目录 `memory.yaml`，获取项目、构建、部署和 UX 记忆变量。
4. 需要选择流程或工具时读 `skills.md`，按任务类型触发对应 skill。
5. 需要并行或委派时读 `subagents.md`，按文件所有权拆分 subagent 任务。
6. 需要中断、续跑、交接或部署收尾时使用 `handoff.md` 模板。

## Update Policy

- 只记录稳定事实、可复用命令、部署拓扑、长期 UX 约束和验证流程。
- 不记录聊天里的临时推测、一次性失败日志、明文密码、token、密钥、证书或 `.env` 内容。
- 如果服务器目录、systemd service、端口、构建命令、移动端规则发生变化，同步更新 `memory.yaml` 和必要规则。
- 如果新增了一类高频任务，先更新 `skills.md` 的路由，再考虑是否创建真正的 Codex skill。
