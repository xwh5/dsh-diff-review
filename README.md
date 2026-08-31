# dsh-diff-review

DeepSeek Harness (DSH) **session change review** plugin — tracks write/edit tool calls and shows side-by-side diffs in the "Review" tab. Read-only review with one-click revert; no external editor required.

[中文说明](README.zh.md)

## ✨ Features

| Feature | Description |
|------|------|
| Auto tracking | Listens to write/edit tool calls, records before/after content and timestamps |
| Side-by-Side Diff | Powered by diff2html |
| Theme following | Automatically adapts to DSH dark/light theme |
| Syntax highlighting | Code syntax highlighting in diffs |
| Session isolation | Each session only shows its own changes |
| Subagent aggregation | Subagent changes aggregate into the root parent session |
| Real-time updates | SSE live push of change state |
| One-click revert | Revert a single change or an entire file |
| Per-turn review card | Shows this turn's changes after each turn; native produced-file previews stay untouched |

## 📦 Install

```bash
dsh plugin --profile web add github:xwh5/dsh-diff-review
```

Refresh the web page after installing.

## 🚀 Usage

1. Open the DSH Web UI
2. After the AI modifies files via write/edit tools
3. Click the "Review" tab above the conversation
4. Switch between "This session" and "Latest turn" views

## 📁 Layout

```
dsh-diff-review/
├── lib/
│   ├── index.js          # host: tool tracking, HTTP routes, revert logic
│   ├── client.js         # client: React components, diff2html rendering
│   └── vendor/
│       ├── diff2html.min.js
│       ├── diff2html-ui.min.js
│       └── diff2html.min.css
├── cordis.patch.yml
├── package.json
└── README.md
```

## 🙏 Credits

- Diff library: [diff2html](https://github.com/rtfpessoa/diff2html) by rtfpessoa

## 📄 License

MIT
