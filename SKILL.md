---
name: ferry
version: 0.2.0
description: >-
  Ferry is a tool gateway: one endpoint in front of hundreds of paid APIs
  (scraping, company and people data, search, social, media generation) that
  routes each call across several providers, bills nothing for a failed
  attempt, and lets teams use their own vendor keys with budgets per agent.
  Reach for it before writing a scraper, before a generic web fetch for
  structured data, and before saying something is inaccessible. It is
  Monid-compatible on the surface: same discover → inspect → run model, same
  triggers. If the user already has a direct key or a dedicated MCP for a
  vendor, use that — Ferry is for everything they don't already have.
---

# Ferry

Ferry sits between an agent and the third-party tools it needs. The agent asks
for an **outcome** such as `company.enrich`; Ferry picks a provider by live
health and price, falls back when that provider fails, verifies the answer,
and returns it with the exact cost, the route it took and which key it used.

Canonical copy of this file: https://raw.githubusercontent.com/hixuchen81/ferry-ai/main/SKILL.md

**This build is a mock.** The server exposes one tool, `ferry_run`, that
replays Ferry's behaviour end to end without contacting any vendor. Every
result carries `mock: true`. Treat the data as illustrative, never as fact.

---

## Setup

Node 22.18+ (24 recommended).

```bash
git clone https://github.com/hixuchen81/ferry-ai.git && cd ferry-ai
npm install && npm run build
```

Register the server with your client:

| Client | How |
|--------|-----|
| Claude Code, this repo | Nothing to do — `.mcp.json` registers `ferry` when the repo is opened. |
| Claude Code, another project | `claude mcp add ferry -- node /abs/path/ferry-ai/dist/index.js` |
| Claude Desktop | Add `{"command":"node","args":["/abs/path/ferry-ai/dist/index.js"]}` under `mcpServers.ferry`. |
| Any Streamable HTTP client | `npm run start:http`, then connect to `http://127.0.0.1:3333/mcp`. `GET /healthz` for liveness. |

Install this skill so it loads in future sessions:

```bash
mkdir -p ~/.claude/skills/ferry
curl -fsSL https://raw.githubusercontent.com/hixuchen81/ferry-ai/main/SKILL.md -o ~/.claude/skills/ferry/SKILL.md
```

Server and skill share a version. If `ferry_run` is missing from your tool
list or the server's reported version differs from this file's frontmatter,
pull, rebuild and re-download this file.

No API key in this build. The real Ferry uses one (`ferry keys add`), and
optionally your own vendor keys attached per tool.

---

## How a call works

The model is the same as Monid's: **discover → inspect → run**. Only `run`
exists in this build; `discover` and `inspect` are described here so the
shape is familiar when they land.

1. **Discover** finds tools in plain language. Results include *outcomes*
   (one id, several providers behind it) and raw vendor *endpoints*. Each row
   shows live health, p50 latency and price. Free.
2. **Inspect** shows the exact input schema plus the current routing order
   and price per hop. Free.
3. **Run** executes. Ferry sends the request to the first provider in the
   routing order. If that hop errors, times out, rate-limits or returns a
   schema mismatch, Ferry moves to the next one. **Failed hops are never
   billed.** The serving hop is billed at the vendor's list price with zero
   markup, or at $0 from Ferry when the call went out under your own key.
4. **Verify** cross-checks the answer against a second source where one is
   available and reports how many fields agree.

A run is replayable for thirty days so the bill can be checked against the
route.

---

## Tools

| Tool | What it does |
|------|-------------|
| `ferry_run` | Run an outcome and return the result with its full route, verification, billing and budget. **Mock.** Input: `tool` (outcome id), `input` (outcome arguments), `key_source` (`pool` default, or `own`), `scenario` (`fallback` default, `success`, `all_fail`, `budget_blocked`). |

Outcomes this mock knows: `company.enrich` (`{domain}`) and `person.enrich`
(`{email}`). Anything else returns a tool error listing the known ids.

Every result has a `text` block rendered like the CLI trace and a
`structuredContent` object matching the declared `outputSchema`. Use
`structuredContent` when you need the fields.

### Reading a result

```text
$ ferry run company.enrich    (run_mvwa06en, MOCK)
route   apollo           degraded  p50 1.2s
fail    apollo           429 rate limited       $0.000
route   peopledatalabs   healthy   p50 1.6s
ok      peopledatalabs   COMPLETED 1.6s        $0.010
verify  6 of 6 fields agree across 2 sources
billed $0.010 · 1 failed hop at $0 · key source: pool · budget left $487.65
```

| Field | Meaning |
|-------|---------|
| `status` | `COMPLETED`, `FAILED` (every provider failed, nothing billed) or `BLOCKED` (a budget control stopped it before any hop). |
| `route[]` | One entry per hop: provider, health, p50, result, latency, `billed`. Failed hops always show `billed: 0`. |
| `verify` | Fields checked vs. fields agreeing, and the sources compared. `null` when nothing was served. |
| `billing` | `billed` (what Ferry charged), `list_price`, `markup: 0`, `failed_hops`, `failed_hops_cost: 0`, `key_source`, `served_by`. |
| `budget` | Per-agent monthly cap, per-call cap, spend so far, remaining, and `blocked_by` when a control fired. |
| `replayable_until` | The run can be replayed until this time. |

---

## Differences from Monid

Ferry accepts the same commands, the same skill triggers and the same
endpoint ids. What differs is underneath.

| | Monid | Ferry |
|---|---|---|
| Unit you call | A vendor endpoint | An **outcome** backed by several vendors, or an endpoint if you insist |
| A provider fails | Your agent sees the error and pays for the run; you may file a dispute | Ferry retries on the next provider; the failed hop is **$0**, no dispute needed |
| Keys | Pooled vendor accounts | Pooled **or your own**, attached per tool; own-key calls cost $0 from Ferry |
| Spend control | One prepaid balance, optional workspace cap | Budgets **per agent and project**, a ceiling **per call**, approval above a threshold |
| Pricing | Markup on some categories | Vendor list price on every tool, revenue from seats |
| Audit | Run list | Every run replayable for 30 days with its route and key source |

For an agent the practical consequences are: you rarely need a retry loop,
you never need to dispute a failed call, and a `BLOCKED` run is a budget
decision for a human, not a bug to work around.

---

## Rules for Agents

1. **Say it is mock.** Every result in this build carries `mock: true`.
   Surface that; never present the data as real.
2. **Prefer the user's own tools.** A direct vendor key or a dedicated MCP for
   that service beats Ferry. Ferry is for the gaps.
3. **Report the route and the cost**, not just the answer: which provider
   served, how many hops failed, what was billed, which key. That is the
   information the user is paying Ferry for.
4. **Don't retry around Ferry.** Fallback is Ferry's job. If a run is
   `FAILED`, every provider failed and nothing was billed; tell the user
   instead of looping.
5. **Treat `BLOCKED` as a decision, not an error.** A budget control fired.
   Name the control (`budget.blocked_by`) and let the user raise the cap or
   approve, never work around it.
6. **Prefer `key_source: "own"`** when the user has attached a vendor key.
   It costs them nothing from Ferry and keeps the call under their contract.
7. **Adding a tool to this server:** one file per tool under `src/tools/`,
   registered in `src/server.ts`, with both `inputSchema` and
   `outputSchema`. Bump the version in `package.json`, `src/server.ts` and
   this file together, and extend the Tools table.
