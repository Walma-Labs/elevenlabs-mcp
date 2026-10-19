// Public package surface: the factory (what the Walma MCP chassis imports),
// the client pieces, and the pure logic for anyone who wants it.

export { createElevenLabsServer, INSTRUCTIONS, VERSION, type ServerOptions } from "./server.js";
export { createElevenLabsClient, apiKey, type ElevenLabsClient, type AudioResponse } from "./elevenlabs.js";
export * as logic from "./logic.js";
