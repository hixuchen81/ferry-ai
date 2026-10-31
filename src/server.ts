import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRunTool } from "./tools/run.ts";

export const SERVER_NAME = "ferry";
export const SERVER_VERSION = "0.2.0";

/** Build a fresh McpServer with every Ferry tool registered. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Ferry is a tool gateway for agents: one endpoint in front of many paid APIs, with routing across " +
        "providers, $0 for failed hops, your own keys or the pool, and budgets per agent. " +
        "This build is a MOCK with one tool, ferry_run. Call it to see a full route trace and billing breakdown; " +
        "no vendor is contacted and nothing is really charged.",
    },
  );

  registerRunTool(server);
  return server;
}
