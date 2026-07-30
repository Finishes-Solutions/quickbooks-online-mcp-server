#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server/build-server.js";

const main = async () => {
  // Create an MCP server with all QuickBooks tools registered.
  const server = buildServer();

  // Start receiving messages on stdin and sending messages on stdout.
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
