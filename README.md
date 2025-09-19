# 简易留言板

一个基于原生 Node.js 的轻量留言板应用，支持 Markdown 输入、Tailwind 风格界面、深浅色主题，以及使用 SQLite 持久化留言。

## 功能亮点
- **Markdown 支持**：前端使用 `marked` + `DOMPurify` 渲染，支持代码块、高亮、列表等常见语法。
- **代码块增强**：自动包裹标题栏与“复制”按钮，可根据语法高亮推断语言，并与主题联动。
- **持久化存储**：留言记录保存到 `data/messages.db`，最多保留 1000 条，超出后自动丢弃最早的记录。
- **分页浏览**：每页显示 50 条留言，最多 20 页，可通过翻页导航快速跳转。
- **深浅色主题**：页面右上角可切换主题，优先读取浏览器偏好并存储在 `localStorage`。
- **语言切换**：内置中文与英文界面，一键切换即时生效并记忆偏好。
- **键盘快捷键**：在输入框按 `Ctrl + Enter` 可快速提交留言。

## 环境要求
- Node.js 18 或更高版本（建议与本地环境一致）
- npm / pnpm / yarn 任一包管理工具

## 快速开始
```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 默认监听地址
# http://localhost:13478
```

首次运行会在项目根目录自动创建 `data/messages.db` 数据库文件，用于持久化所有留言。

## 项目结构
- `server.js`：应用入口，包含 HTTP 服务、页面模板、 SQLite 访问逻辑以及前端脚本。
- `data/messages.db`：SQLite 数据库（首次启动后生成，可按需备份或清空）。
- `package.json`：依赖及 npm 脚本。

## 使用小贴士
- 删除按钮位于每条留言右上角，可删除指定记录。
- 主题切换会自动记忆上一次选择，如需恢复系统默认，可清理浏览器的 `localStorage`。
- 若要重置留言数据，可停止服务并删除 `data/messages.db` 后重新启动。
- 生产环境可考虑：
  - 将 Tailwind CDN 替换为本地构建的 CSS；
  - 增加访问限制或鉴权逻辑；
  - 部署前配置进程守护和日志轮转。

欢迎根据需求继续扩展功能，例如增加搜索、导出、图片上传等能力。

---

# Simple Message Board (English)

A lightweight message board built with vanilla Node.js. It supports Markdown input, Tailwind-inspired styling, dark/light themes, and SQLite persistence.

## Highlights
- **Markdown Support**: Renders Markdown on the client with `marked` + `DOMPurify`, including lists, code blocks, and syntax highlighting.
- **Enhanced Code Blocks**: Each block gains a header, language hint, and one-click copy button that respects the active theme.
- **Persistent Storage**: Messages are saved in `data/messages.db`. The board keeps at most 1,000 entries and automatically trims the oldest ones.
- **Pagination**: Displays 50 messages per page (up to 20 pages) with easy navigation controls.
- **Dark & Light Themes**: Switch themes from the top-right toggle. Preferences are stored in `localStorage` and aligned with system defaults.
- **Bilingual UI**: Chinese and English interfaces baked in; the switch updates instantly and remembers your choice.
- **Keyboard Shortcut**: Press `Ctrl + Enter` inside the textarea to submit instantly.

## Requirements
- Node.js 18 or newer (match your local runtime when possible)
- npm / pnpm / yarn

## Quick Start
```bash
# Install dependencies
npm install

# Start the server
npm start

# Visit the app
# http://localhost:13478
```

On first launch the app creates `data/messages.db` in the project root to persist all messages.

## Project Layout
- `server.js`: Entry point with HTTP server, page template, SQLite access, and client-side logic.
- `data/messages.db`: SQLite database file (generated on demand; back up or delete as needed).
- `package.json`: Dependencies and npm scripts.

## Tips
- Use the delete button at the top-right of each message to remove it.
- Theme choices are stored locally; clear `localStorage` to fall back to system defaults.
- To reset all messages, stop the server, delete `data/messages.db`, then restart.
- For production consider:
  - Bundling Tailwind locally instead of loading from the CDN.
  - Adding authentication or rate limiting.
  - Using a process manager and log rotation.

Feel free to extend the app with search enhancements, exports, image uploads, or any other ideas you have.
