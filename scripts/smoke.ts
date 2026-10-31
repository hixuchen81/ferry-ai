// Smoke test: spawn the server over stdio (or connect over HTTP with --http <url>),
// list tools, call ferry_run in a few scenarios, and assert the gateway invariants.
//
//   node scripts/smoke.ts                      # stdio, runs `node src/index.ts`
//   node scripts/smoke.ts --http http://127.0.0.1:3333/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const httpIdx = argv.indexOf("--http");
const httpUrl = httpIdx !== -1 ? argv[httpIdx + 1] : undefined;

const transport = httpUrl
  ? new StreamableHTTPClientTransport(new URL(httpUrl))
  : new StdioClientTransport({ command: "node", args: ["src/index.ts"], stderr: "inherit" });

const client = new Client({ name: "ferry-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name));
if (!tools.tools.some((t) => t.name === "ferry_run")) throw new Error("ferry_run not registered");

type Run = {
  status: string;
  route: { result: string; billed: number }[];
  billing: { billed: number; failed_hops: number; failed_hops_cost: number; key_source: string };
  budget: { blocked_by: string | null };
  result: unknown;
};

async function run(args: Record<string, unknown>): Promise<Run> {
  const r = await client.callTool({ name: "ferry_run", arguments: args });
  if (r.isError) throw new Error(`tool error: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Run;
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

// 1. default fallback: first hop fails at $0, second serves, billed once at list price
const fb = await run({ tool: "company.enrich", input: { domain: "stripe.com" } });
console.log((await client.callTool({ name: "ferry_run", arguments: { tool: "company.enrich", input: { domain: "stripe.com" } } })).content[0]);
assert(fb.status === "COMPLETED", "fallback completes");
assert(fb.route.length === 2 && fb.route[0]!.result !== "ok" && fb.route[1]!.result === "ok", "one failed hop then success");
assert(fb.route[0]!.billed === 0 && fb.billing.failed_hops === 1 && fb.billing.failed_hops_cost === 0, "failed hop is $0");
assert(fb.billing.billed === 0.01, "billed list price of serving provider");

// 2. own key: Ferry bills nothing
const own = await run({ tool: "company.enrich", input: { domain: "stripe.com" }, key_source: "own" });
assert(own.billing.billed === 0 && own.billing.key_source === "own", "own key → $0 from Ferry");

// 3. all providers fail: FAILED, nothing billed
const af = await run({ tool: "company.enrich", input: { domain: "stripe.com" }, scenario: "all_fail" });
assert(af.status === "FAILED" && af.billing.billed === 0 && af.result === null, "all_fail bills nothing");

// 4. budget cap: BLOCKED before any hop
const bb = await run({ tool: "person.enrich", input: { email: "jane.doe@stripe.com" }, scenario: "budget_blocked" });
assert(bb.status === "BLOCKED" && bb.route.length === 0 && bb.budget.blocked_by === "PER_CALL_CAP", "budget block has no hops");

// 5. unknown outcome → isError
const bad = await client.callTool({ name: "ferry_run", arguments: { tool: "nope.x", input: {} } });
assert(bad.isError === true, "unknown outcome is a tool error");

console.log(`OK via ${httpUrl ? "http" : "stdio"} — 5 scenarios passed`);
await client.close();
