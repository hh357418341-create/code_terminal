# Harness Rules

## Repository Workflow

- 修改前先读相关代码、配置、README、`AGENTS.md` 和本 harness。
- 只改任务相关文件；遇到未跟踪或非本次改动文件时不要清理、回滚或覆盖。
- 每次代码或规则修改完成后，运行最贴近改动面的检查；发布前至少运行 `npm run build:frontend` 和 `npm run build`。
- 按仓库规则，每次修改完成后都要重新打包 Windows exe，并提交一把 git。
- 提交前说明修改文件、修改原因、实际验证命令和结果摘要。

## Security

- 不把服务器密码、token、密钥、证书、cookie、`.env` 明文写入仓库、提交信息、日志文件或 harness memory。
- 服务器部署可记录 host、端口、目录、service 名称和验证命令，但凭据只能通过交互输入或服务器已有环境文件使用。
- 输出部署结果时不要复述密码或 token；需要访问 token 时只提示“使用原有 token 链接”。

## Mobile UI

- 手机访问界面空间有限，顶部功能/操作栏必须支持隐藏、收纳或横向滚动，优先把终端可用区域放大。
- 移动端操作栏不得挤压调色、主题、字号、行距等外观设置区域。
- 外观设置在窄屏下应独立换行、横向滚动或折叠，颜色选择器必须保持可点击且不被其他控件压缩。
- 修改移动端 UI 后，至少用 390x844 和 360x740 视口检查顶部栏、外观栏、终端区和输入框是否重叠。

## Terminal Input

- 底部对话输入框必须保持 `Enter` 发送消息。
- 只有 `Shift+Enter` 能在对话输入框内插入换行。
- 输入框为空时，`Enter`、方向键、PageUp/PageDown、Home/End 应继续转发给当前 TUI/终端。
- 向 Codex TUI 发送非空文本时，先 bracketed paste 写入文本，再延迟发送一次回车触发提交。

