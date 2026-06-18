# Code Terminal 关键代码摘录

这是给别人参考/照着抄的精简版源码包，不是完整应用。

完整仓库的核心实现主要分布在：

- `src-tauri/src/lib.rs`：Tauri 桌面端 PTY 后端。
- `src-tauri/src/server.rs`：HTTP/WebSocket 服务器模式 PTY 后端。
- `src/TerminalSessionView.tsx`：xterm.js 与后端 PTY 事件桥接。
- `src/TerminalPane.tsx`：多终端、底部输入框、Enter/Shift+Enter/TUI 按键转发。
- `src/tauriRuntime.ts`：Tauri / server / preview 三种运行时的 invoke/listen 兼容层。
- `src/clipboardImages.ts`：剪贴板图片保存成临时文件路径。

本目录按最小可抄核心拆成下面几个文件：

- `backend-pty-core.rs`：Rust + portable-pty 创建真实本地终端，处理写入、resize、停止和输出事件。
- `TerminalSessionView.core.tsx`：React + xterm.js 终端视图，接收 `terminal-output`，发送 `terminal_write`。
- `TerminalComposer.core.tsx`：底部输入框关键交互，保证 `Enter` 发送、`Shift+Enter` 换行、空输入时按键转发给 TUI。
- `tauriRuntime.core.ts`：桌面版最小 Tauri `invoke/listen` 封装。
- `clipboardImages.core.ts`：图片粘贴桥接。
- `minimal-dependencies.md`：前后端关键依赖和抄代码顺序。

## 最关键的交互规则

底部输入框必须保持：

- 非空 `Enter`：提交消息给当前 TUI/终端。
- `Shift+Enter`：只在输入框内插入换行。
- 空输入框 `Enter`：发送 `\r` 给当前 TUI/终端，用于确认选择。
- 空输入框方向键、`PageUp/PageDown`、`Home/End`：转发 ANSI escape 给当前 TUI/终端。
- bracketed paste 模式下发送非空文本：先发送 `\x1b[200~文本\x1b[201~`，再延迟发送一次 `\r`。

## 使用建议

别人如果要从零抄：

1. 先抄 `backend-pty-core.rs`，注册 Tauri command。
2. 再抄 `TerminalSessionView.core.tsx`，让 xterm 和后端 PTY 打通。
3. 最后抄 `TerminalComposer.core.tsx`，补底部输入框协议。
4. 项目列表、多 Tab、多瓦片、主题、对话视图、服务器模式可以后续再补。

