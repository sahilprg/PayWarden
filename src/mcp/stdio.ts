/**
 * Paywarden MCP server over stdio, for MCP hosts that launch a local process
 * (Claude Desktop, Claude Code, IDE agents and others).
 *
 *   PAYWARDEN_URL=https://paywarden.onrender.com AGENT_API_TOKEN=... npm run mcp
 *
 * It holds only the AGENT token, so the agent can ask to pay but can never
 * approve, refund, revoke or freeze. stdout carries the protocol: log to stderr.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { HttpAgentApi } from './agent-api.js';
import { createPaywardenMcpServer } from './server.js';

const url = process.env['PAYWARDEN_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3000}`;
const token = process.env['AGENT_API_TOKEN'];
if (!token) {
  console.error('AGENT_API_TOKEN is required: the agent token of the Paywarden server at PAYWARDEN_URL.');
  process.exit(1);
}

const api = new HttpAgentApi(url, token);
serveStdio(() => createPaywardenMcpServer(api));
console.error(`paywarden-mcp-server on stdio, talking to ${url} with the agent token`);
