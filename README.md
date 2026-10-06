# 🔧 开发者工具箱 · Toolbox

一组免费、无需登录、**纯前端运行**的日常小工具。所有计算都在你的浏览器里完成，数据不会上传到任何服务器。

> 在线使用：https://huqinyuan923-hue.github.io/toolbox/

## ✨ 功能

| 工具 | 说明 |
|---|---|
| JSON 格式化 | 格式化（2 空格缩进）与压缩，出错时给出具体原因 |
| 时间戳转换 | 秒/毫秒互转，实时显示当前时间戳 |
| 二维码生成 | 输入文字或链接生成二维码，可下载 PNG |
| 密码生成 | 基于 `crypto.getRandomValues`，可选字符集，保证每类字符至少出现一次 |
| Markdown 预览 | 左写右看，实时渲染（DOMPurify 过滤 XSS） |
| 每日一签 | 按日期确定性挑选一句话 + 每日配图，同一天所有人看到同一句 |

## 🚀 使用 / 部署

纯静态站点，无需构建：

```bash
# 本地预览：直接双击 index.html，或
npx serve .
```

部署到 GitHub Pages：仓库 Settings → Pages → 选择 `main` 分支根目录即可。

## ➕ 添加新工具

1. 在 `index.html` 的导航里加一个 `<button class="tool-btn" data-tool="你的工具名">`
2. 添加 `<section id="tool-你的工具名" class="tool-panel">` 面板
3. 在 `script.js` 里写逻辑，标签切换自动生效

## 🛠 技术栈

HTML + CSS + 原生 JavaScript，零框架、零构建。二维码与 Markdown 渲染通过 CDN 引入 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)、[marked](https://github.com/markedjs/marked)、[DOMPurify](https://github.com/cure53/DOMPurify)。

## 📄 License

MIT
