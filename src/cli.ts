#!/usr/bin/env node
// Local entrypoint — `elevenlabs-mcp` runs the stdio server for Claude Code,
// Claude Desktop, Cursor and any stdio MCP client. Audio is saved to
// ELEVENLABS_OUTPUT_DIR (default ~/elevenlabs-output).

import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createElevenLabsServer } from "./server.js";
import { createElevenLabsClient } from "./elevenlabs.js";

const dir = process.env.ELEVENLABS_OUTPUT_DIR || "~/elevenlabs-output";
const server = createElevenLabsServer(createElevenLabsClient(), {
  outputDir: dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir,
});
await server.connect(new StdioServerTransport());
