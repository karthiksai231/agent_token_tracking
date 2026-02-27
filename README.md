# llm-spend

> Local LLM cost dashboard for Claude Code. One command, zero setup.

```bash
npx llm-spend
```

Opens a dashboard at `http://localhost:3000` showing exactly where your Claude tokens and dollars are going — by model, session, project, and individual request.

---

## Features

- **Zero setup** — auto-reads `~/.claude/projects/` on startup, no config required
- **Overview** — daily spend chart, cost-by-model donut, 5 stat cards with tooltips
- **Actionable insights** — 8 expandable insight cards (cache efficiency, model mix, session efficiency, spend trajectory, monthly projection, and more)
- **Projects breakdown** — cost ranked by project path
- **Sessions tab** — top sessions by cost with cost-per-request efficiency metric
- **Top Requests by Cost** — 15 most expensive individual API calls, with the original prompt shown inline (collapsible)
- **Date range filters** — Today / 7D / 30D / All, with live chart refresh
- **Privacy-first** — server binds to `127.0.0.1` only, no telemetry, no external calls

---

## Quickstart

```bash
# One-off (no install)
npx llm-spend

# Or install globally
npm install -g llm-spend
llm-spend
```

---

## CLI Options

```
llm-spend [options]

Options:
  -p, --port <number>      Port to listen on (default: 3000)
  --no-open                Do not open browser automatically
  --claude-dir <path>      Path to Claude data directory (default: ~/.claude)
  -V, --version            Output version number
  -h, --help               Display this help
```

---

## Supported Models

**Anthropic:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-6 (and 4.5, 4, 3.7, 3.5, 3 variants)
**OpenAI:** gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, o1, o1-mini, o3-mini, o4-mini

Unknown models are tracked but show $0 cost.

---

## Privacy

- Server binds to `127.0.0.1` — not accessible from other machines
- No prompts or responses are stored — only token counts, model name, timestamps, and computed cost
- No telemetry or external HTTP calls whatsoever
- All data is read directly from your local `~/.claude/` directory

---

## License

MIT
