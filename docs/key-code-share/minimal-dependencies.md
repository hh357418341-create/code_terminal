# 最小依赖

## package.json 关键依赖

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.9.0",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.9.0",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

## Cargo.toml 关键依赖

```toml
[dependencies]
portable-pty = "0.9.0"
serde = { version = "1", features = ["derive"] }
tauri = { version = "2", features = [] }
uuid = { version = "1", features = ["v4"] }

[target.'cfg(windows)'.dependencies]
windows-version = "0.1.7"
```

## 最小 CSS

```css
html,
body,
#root {
  width: 100%;
  height: 100%;
  margin: 0;
}

.terminal-pane {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  background: #070b10;
  color: #d7dde7;
}

.terminal-host {
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.terminal-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #1d2733;
  background: #0c121a;
}

.terminal-composer textarea {
  resize: none;
  min-height: 42px;
  max-height: 120px;
  padding: 8px 10px;
  border: 1px solid #243244;
  background: #071018;
  color: #d7dde7;
  font: 14px/1.35 Consolas, monospace;
  outline: none;
}

.terminal-composer button {
  padding: 0 14px;
}
```

