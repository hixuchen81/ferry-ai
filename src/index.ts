#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";

/**
 * Entry point.
 *
 *   node dist/index.js                 → stdio transport (what Claude Code / Claude Desktop spawn)
 *   node dist/index.js --http [port]   → Streamable HTTP on http://127.0.0.1:<port>/mcp (remote-style, like mcp.monid.ai)
 *
 * Logs go to stderr only: stdout is the MCP wire in stdio mode.
 */

function parseArgs(argv: string[]): { http: boolean; port: number } {
  const i = argv.indexOf("--http");
  if (i === -1) return { http: false, port: 0 };
  const raw = argv[i + 1];
  const port = raw && !raw.startsWith("--") ? Number(raw) : Number(process.env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return { http: true, port };
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio`);
}

async function runHttp(port: number): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. MCP endpoint is /mcp");
      return;
    }

    // Stateless mode: a fresh server + transport per request, no session ids.
    // Simplest thing that works for a mock; swap in a session map if state is ever needed.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[${SERVER_NAME}] request failed:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} listening on http://127.0.0.1:${actualPort}/mcp`);

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const { http, port } = parseArgs(process.argv.slice(2));
(http ? runHttp(port) : runStdio()).catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});
