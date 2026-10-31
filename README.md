# ferry-ai

Ferry 是一个给 agent 用的工具网关，表面上和 [Monid](https://monid.ai/SKILL.md) 兼容（同样的
discover → inspect → run，同样的触发词），底下不一样：按 outcome 跨多个 provider 路由、失败的
hop 永远 $0、可以用自己的 vendor key、预算按 agent 和每次调用设上限、零加价。

这个 repo 目前是一个 **mock**，用来把整条链路跑通：

- **`SKILL.md`** — 给 agent 看的说明书，可通过
  `https://raw.githubusercontent.com/hixuchen81/ferry-ai/main/SKILL.md` 直链拿到。
  里面有一节 Differences from Monid 说清楚哪里一样、哪里不一样。
- **MCP server** — `src/` 下的 TypeScript，默认 stdio，加 `--http` 走 Streamable HTTP。
- **一个 mock 工具 `ferry_run`** — 模拟一次 outcome 调用，返回完整的路由轨迹、验证、计费和预算：

```text
$ ferry run company.enrich    (run_mvwa06en, MOCK)
route   apollo           degraded  p50 1.2s
fail    apollo           429 rate limited       $0.000
route   peopledatalabs   healthy   p50 1.6s
ok      peopledatalabs   COMPLETED 1.6s        $0.010
verify  6 of 6 fields agree across 2 sources
billed $0.010 · 1 failed hop at $0 · key source: pool · budget left $487.65
```

`scenario` 参数可以强制走 `success`、`all_fail`、`budget_blocked`；`key_source: "own"` 演示自带 key 时 Ferry 收 $0。

## 跑起来

```bash
npm install
npm run build
npm run smoke          # SDK Client 走 stdio：列工具，跑 5 个场景并断言网关不变量
```

HTTP 模式：

```bash
npm run start:http     # http://127.0.0.1:3333/mcp，GET /healthz 看活
npm run smoke -- --http http://127.0.0.1:3333/mcp
```

开发时不用 build，Node 24 直接跑 TS：`npm run dev`。

## 在 Claude Code 里用

repo 自带 `.mcp.json`，在这个目录打开 Claude Code 就会注册名为 `ferry` 的 server；
`.claude/skills/ferry/SKILL.md` 是指向根目录 `SKILL.md` 的 symlink，skill 一起加载。
需要先 `npm run build`，因为 `.mcp.json` 指向 `dist/index.js`。

## 加新工具

照 `src/tools/run.ts` 的样子：一个文件一个工具，声明 `inputSchema` 和 `outputSchema`，在
`src/server.ts` 注册，然后同步 `SKILL.md` 的工具表和三处 version（package.json、server.ts、SKILL.md）。
