import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ferry_run — the one and only tool on this server, and a MOCK.
 *
 * It simulates what Ferry does between a request and an answer: pick a route
 * across several providers for an *outcome*, fall back when a hop fails, bill
 * $0 for every failed hop, verify the answer across sources, and report which
 * key the call went out under and how much budget is left. Nothing here talks
 * to the network.
 */

// ---- catalog -------------------------------------------------------------

type Provider = { id: string; health: "healthy" | "degraded"; p50_ms: number; price: number };

type Outcome = {
  id: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  providers: Provider[]; // current routing order
  resolve: (input: Record<string, unknown>) => Record<string, unknown>;
};

function labelFromDomain(domain: string): string {
  const stem = domain.replace(/^www\./, "").split(".")[0] ?? domain;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

const OUTCOMES: Record<string, Outcome> = {
  "company.enrich": {
    id: "company.enrich",
    description: "Basic company facts from a domain",
    input: z.object({ domain: z.string().min(3) }),
    providers: [
      { id: "apollo", health: "degraded", p50_ms: 1200, price: 0.008 },
      { id: "peopledatalabs", health: "healthy", p50_ms: 1600, price: 0.01 },
      { id: "companies-api", health: "healthy", p50_ms: 2100, price: 0.012 },
    ],
    resolve: (input) => {
      const domain = String(input.domain).toLowerCase();
      return {
        name: labelFromDomain(domain),
        domain,
        industry: "Software",
        employees: 1000 + (domain.length * 137) % 9000,
        founded: 2000 + (domain.length % 20),
        hq: "San Francisco, CA",
      };
    },
  },
  "person.enrich": {
    id: "person.enrich",
    description: "Public profile facts from a work email",
    input: z.object({ email: z.string().email() }),
    providers: [
      { id: "peopledatalabs", health: "healthy", p50_ms: 1400, price: 0.02 },
      { id: "apollo", health: "degraded", p50_ms: 1100, price: 0.015 },
    ],
    resolve: (input) => {
      const email = String(input.email).toLowerCase();
      const [local, domain = ""] = email.split("@");
      return {
        email,
        name: (local ?? "").split(/[._-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
        company: labelFromDomain(domain),
        title: "Engineer",
      };
    },
  },
};

// ---- mock budget ---------------------------------------------------------

const BUDGET = { agent: "default", monthly_cap: 500, per_call_cap: 0.5, spent_month: 12.34 };

// ---- scenarios -----------------------------------------------------------

const SCENARIOS = ["fallback", "success", "all_fail", "budget_blocked"] as const;
type Scenario = (typeof SCENARIOS)[number];

type Hop = {
  provider: string;
  health: Provider["health"];
  p50_ms: number;
  result: "ok" | "429 rate limited" | "timeout" | "schema mismatch";
  latency_ms: number;
  billed: number; // always 0 on failure
};

function money(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- tool ----------------------------------------------------------------

export function registerRunTool(server: McpServer): void {
  server.registerTool(
    "ferry_run",
    {
      title: "Ferry run (mock gateway call)",
      description:
        "Run a Ferry outcome such as `company.enrich` and get back the result together with the full route: " +
        "which providers were tried, which failed, what each hop cost (failed hops are always $0), how the answer was " +
        "verified, which key the call went out under, and how much budget remains. " +
        "This is MOCK data generated locally — no vendor is called. Use `scenario` to force a path; the default " +
        "`fallback` shows one provider failing and the next answering.",
      inputSchema: {
        tool: z.string().describe("Outcome id, e.g. \"company.enrich\" or \"person.enrich\""),
        input: z.record(z.string(), z.unknown()).describe("Outcome input, e.g. {\"domain\":\"stripe.com\"}"),
        key_source: z.enum(["pool", "own"]).default("pool").describe("pool = Ferry's vendor account at list price; own = your attached vendor key, $0 from Ferry"),
        scenario: z.enum(SCENARIOS).default("fallback").describe("Which path to simulate"),
      },
      outputSchema: {
        mock: z.literal(true),
        run_id: z.string(),
        tool: z.string(),
        kind: z.literal("outcome"),
        status: z.enum(["COMPLETED", "FAILED", "BLOCKED"]),
        route: z.array(
          z.object({
            provider: z.string(),
            health: z.enum(["healthy", "degraded"]),
            p50_ms: z.number(),
            result: z.string(),
            latency_ms: z.number(),
            billed: z.number(),
          }),
        ),
        verify: z
          .object({ fields_checked: z.number(), fields_agreeing: z.number(), sources: z.array(z.string()) })
          .nullable(),
        result: z.record(z.string(), z.unknown()).nullable(),
        error: z.string().nullable(),
        billing: z.object({
          billed: z.number(),
          list_price: z.number(),
          markup: z.literal(0),
          failed_hops: z.number(),
          failed_hops_cost: z.literal(0),
          key_source: z.enum(["pool", "own"]),
          served_by: z.string().nullable(),
        }),
        budget: z.object({
          agent: z.string(),
          monthly_cap: z.number(),
          per_call_cap: z.number(),
          spent_month: z.number(),
          remaining_month: z.number(),
          blocked_by: z.string().nullable(),
        }),
        replayable_until: z.string(),
      },
    },
    async ({ tool, input, key_source, scenario }) => {
      const outcome = OUTCOMES[tool];
      if (!outcome) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown outcome "${tool}". This mock knows: ${Object.keys(OUTCOMES).join(", ")}.`,
            },
          ],
        };
      }
      const parsed = outcome.input.safeParse(input);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid input for ${tool}: ${parsed.error.message}` }],
        };
      }

      const now = new Date();
      const runId = `run_${now.getTime().toString(36)}`;
      const replayableUntil = new Date(now.getTime() + 30 * 86_400_000).toISOString();
      const { route, result, served, error, status, blockedBy } = simulate(outcome, parsed.data, scenario as Scenario);

      const listPrice = served ? served.price : 0;
      const billed = key_source === "own" ? 0 : money(listPrice);
      const failedHops = route.filter((h) => h.result !== "ok").length;

      const structured = {
        mock: true as const,
        run_id: runId,
        tool: outcome.id,
        kind: "outcome" as const,
        status,
        route,
        verify: served
          ? { fields_checked: Object.keys(result ?? {}).length, fields_agreeing: Object.keys(result ?? {}).length, sources: [served.id, "ferry-cache"] }
          : null,
        result,
        error,
        billing: {
          billed,
          list_price: money(listPrice),
          markup: 0 as const,
          failed_hops: failedHops,
          failed_hops_cost: 0 as const,
          key_source,
          served_by: served?.id ?? null,
        },
        budget: {
          agent: BUDGET.agent,
          monthly_cap: BUDGET.monthly_cap,
          per_call_cap: BUDGET.per_call_cap,
          spent_month: money(BUDGET.spent_month + billed),
          remaining_month: money(BUDGET.monthly_cap - BUDGET.spent_month - billed),
          blocked_by: blockedBy,
        },
        replayable_until: replayableUntil,
      };

      return {
        content: [{ type: "text", text: renderTrace(structured) }],
        structuredContent: structured,
      };
    },
  );
}

function simulate(
  outcome: Outcome,
  input: Record<string, unknown>,
  scenario: Scenario,
): {
  route: Hop[];
  result: Record<string, unknown> | null;
  served: Provider | null;
  error: string | null;
  status: "COMPLETED" | "FAILED" | "BLOCKED";
  blockedBy: string | null;
} {
  const [p0, p1] = outcome.providers;
  if (!p0) throw new Error("outcome has no providers");

  const hop = (p: Provider, result: Hop["result"], latency: number): Hop => ({
    provider: p.id,
    health: p.health,
    p50_ms: p.p50_ms,
    result,
    latency_ms: latency,
    billed: 0, // set below only for the serving hop
  });

  switch (scenario) {
    case "budget_blocked":
      return {
        route: [],
        result: null,
        served: null,
        error: `Per-call cap $${BUDGET.per_call_cap.toFixed(2)} would be exceeded; approval required`,
        status: "BLOCKED",
        blockedBy: "PER_CALL_CAP",
      };
    case "all_fail": {
      const kinds: Hop["result"][] = ["429 rate limited", "timeout", "schema mismatch"];
      const route = outcome.providers.map((p, i) => hop(p, kinds[i % kinds.length]!, p.p50_ms + 400 * i));
      return { route, result: null, served: null, error: "All providers failed; nothing billed", status: "FAILED", blockedBy: null };
    }
    case "success": {
      const served = p0;
      const h = hop(served, "ok", served.p50_ms);
      h.billed = served.price;
      return { route: [h], result: outcome.resolve(input), served, error: null, status: "COMPLETED", blockedBy: null };
    }
    case "fallback":
    default: {
      const served = p1 ?? p0;
      const first = hop(p0, "429 rate limited", 310);
      const second = hop(served, "ok", served.p50_ms);
      second.billed = served.price;
      return { route: p1 ? [first, second] : [second], result: outcome.resolve(input), served, error: null, status: "COMPLETED", blockedBy: null };
    }
  }
}

function renderTrace(s: {
  run_id: string;
  tool: string;
  status: string;
  route: Hop[];
  verify: { fields_checked: number; fields_agreeing: number; sources: string[] } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  billing: { billed: number; failed_hops: number; key_source: string; served_by: string | null };
  budget: { remaining_month: number; blocked_by: string | null };
}): string {
  const lines: string[] = [`$ ferry run ${s.tool}    (${s.run_id}, MOCK)`];
  for (const h of s.route) {
    lines.push(`route   ${h.provider.padEnd(16)} ${h.health.padEnd(9)} p50 ${(h.p50_ms / 1000).toFixed(1)}s`);
    lines.push(
      h.result === "ok"
        ? `ok      ${h.provider.padEnd(16)} COMPLETED ${(h.latency_ms / 1000).toFixed(1)}s        $${h.billed.toFixed(3)}`
        : `fail    ${h.provider.padEnd(16)} ${h.result.padEnd(22)} $0.000`,
    );
  }
  if (s.verify) lines.push(`verify  ${s.verify.fields_agreeing} of ${s.verify.fields_checked} fields agree across ${s.verify.sources.length} sources`);
  if (s.error) lines.push(`${s.status.toLowerCase().padEnd(7)} ${s.error}`);
  lines.push(
    `billed $${s.billing.billed.toFixed(3)} · ${s.billing.failed_hops} failed hop${s.billing.failed_hops === 1 ? "" : "s"} at $0 · key source: ${s.billing.key_source}` +
      ` · budget left $${s.budget.remaining_month.toFixed(2)}${s.budget.blocked_by ? ` · blocked by ${s.budget.blocked_by}` : ""}`,
  );
  if (s.result) lines.push("", JSON.stringify(s.result, null, 2));
  return lines.join("\n");
}
