# dsh-diff-review

DeepSeek Harness（DSH）**会话修改审查**插件：自动追踪会话内的文件写入/编辑操作，在「审查」标签页展示 side-by-side diff 对比，主题自动跟随 DSH。纯只读审查 + 一键撤回，不依赖任何外部编辑器。

[English](README.md)

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 自动追踪 | 监听 write/edit 工具调用，记录修改前后内容与时间 |
| Side-by-Side Diff | 集成 diff2html，并排对比视图 |
| 主题自动跟随 | 自动适配 DSH 深色/浅色主题，无需手动配置 |
| 语法高亮 | 支持代码语法高亮显示 |
| 会话隔离 | 每个会话只展示自己的修改 |
| 子代理聚合 | 子代理的修改自动聚合到根父会话 |
| 实时推送 | SSE 实时更新修改状态 |
| 一键撤回 | 支持单个修改或整个文件的撤回 |
| 轮次审查卡片 | 每轮对话尾部展示本轮变更；原生「产物」预览不受影响 |

## 📦 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:xwh5/dsh-diff-review
```

安装后刷新网页即可使用。

## 🚀 使用

1. 打开 DSH Web 界面
2. AI 执行 write/edit 工具修改文件后
3. 点击对话上方的「审查」标签查看修改
4. 支持「此会话」和「最新一轮」两种视图

## 📸 截图

> 以下为插件在 DSH Web 界面中的实际效果截图。

![DSH 修改审查插件界面截图 1](docs/screenshots/screenshot-1.png)

![DSH 修改审查插件界面截图 2](docs/screenshots/screenshot-2.png)

## 📁 文件结构

```
dsh-diff-review/
├── lib/
│   ├── index.js          # 后端：工具执行监听、HTTP 路由、撤回逻辑
│   ├── client.js         # 前端：React 组件、diff2html 渲染
│   └── vendor/
│       ├── diff2html.min.js
│       ├── diff2html-ui.min.js
│       └── diff2html.min.css
├── docs/
│   └── screenshots/      # 界面截图（见上方「截图」）
├── cordis.patch.yml
├── package.json
└── README.md
```

## 🙏 致谢

- Diff 库：[diff2html](https://github.com/rtfpessoa/diff2html) by rtfpessoa

## 📄 License

MIT
