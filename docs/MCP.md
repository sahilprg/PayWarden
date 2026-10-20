# Paywarden for AI agents (MCP)

Paywarden exposes an [MCP](https://modelcontextprotocol.io) server, so any MCP-capable agent can use it as its way to pay through PayPal. The server holds only the **agent token**: an agent can read its permit, browse the catalogue, ask to pay, and check or capture an order its person approved. Approving, refunding, revoking and freezing are owner actions it cannot reach.

## Tools

| Tool | What it does |
|---|---|
| `paywarden_get_spending_permit` | The agent's signed permits: rules written out by code, remaining budget, approved quotes |
| `paywarden_browse_catalog` | The merchant's items with real prices and categories |
| `paywarden_request_payment` | Ask to pay for a basket under a permit. Result: allowed (with a PayPal link for the person), sent to the owner, or refused with reasons. Page text the agent read can be passed for injection checks. Safe to retry with the same `request_id`. |
| `paywarden_check_payment` | Status of an order and the next step |
| `paywarden_capture_payment` | Collect a payment the person approved in PayPal (authority is re-checked first) |

## Option 1: hosted endpoint (Streamable HTTP)

URL: `https://<your-paywarden-address>/mcp`, with the header `Authorization: Bearer <AGENT_API_TOKEN>`.

For clients that read a JSON config:

```json
{
  "mcpServers": {
    "paywarden": {
      "type": "http",
      "url": "https://paywarden.onrender.com/mcp",
      "headers": { "Authorization": "Bearer <AGENT_API_TOKEN>" }
    }
  }
}
```

## Option 2: local stdio server

The local server talks to a running Paywarden (local or hosted) over HTTP with the agent token.

```bash
PAYWARDEN_URL=https://paywarden.onrender.com AGENT_API_TOKEN=<agent token> npm run mcp
```

For a desktop MCP host, point it at the repo:

```json
{
  "mcpServers": {
    "paywarden": {
      "command": "npx",
      "args": ["tsx", "/path/to/PayWarden/src/mcp/stdio.ts"],
      "env": { "PAYWARDEN_URL": "https://paywarden.onrender.com", "AGENT_API_TOKEN": "<agent token>" }
    }
  }
}
```

To explore the tools interactively: `npx @modelcontextprotocol/inspector npx tsx src/mcp/stdio.ts` (with the same two environment variables set).

## A typical agent turn

1. `paywarden_get_spending_permit` to learn the limits and the approved quote.
2. `paywarden_browse_catalog` to pick skus.
3. `paywarden_request_payment` with the basket, the quote and any page text it read.
4. Hand the returned PayPal link to the person. They approve in PayPal.
5. `paywarden_capture_payment` to collect it.

If the agent is talked into adding a gift card by a product page, step 3 comes back **refused** with `CATEGORY_DENIED` and `INJECTION_SUSPECTED`, and the tool tells the agent not to work around it.

## Tests

`test/mcp.test.ts` drives both transports with the official MCP client: tool list, a full purchase, refusal of a hijacked basket, safe retries, and the guarantee that the owner token cannot connect and no owner tool exists.
