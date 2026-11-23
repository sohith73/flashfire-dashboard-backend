# FlashFire MCP server

Clients can connect Claude to their own FlashFire account.
Claude then does what the client can do on the portal, and nothing an operator does.

## How a client connects

1. Portal, Profile, Connect to Claude, Create key.
   The key (`ffmcp_` + 43 characters) is shown once.
2. Add it to Claude in one of three ways, all shown on that card:
   - Claude app or claude.ai: Settings, Connectors, Add custom connector, URL `https://<api>/mcp/u/<key>`.
   - Claude Code: `claude mcp add --transport http flashfire https://<api>/mcp --header "Authorization: Bearer <key>"`.
   - Any MCP client: the JSON config, `{"mcpServers":{"flashfire":{"type":"http","url":"https://<api>/mcp","headers":{"Authorization":"Bearer <key>"}}}}`.
3. Revoke on the same card. The next call with that key gets 401.

No env vars are needed.
The card builds its URLs from `VITE_API_BASE_URL`.

## Endpoints

| Route | Auth | What |
|---|---|---|
| `GET /mcp-keys` | client JWT | List live keys (id, name, prefix, createdAt, lastUsedAt). Never the key. |
| `POST /mcp-keys` | client JWT | `{ name }`, returns the key once. 409 at 5 live keys. |
| `DELETE /mcp-keys/:id` | client JWT | Revoke. 404 if not this client's or already revoked. |
| `POST /mcp` | `Authorization: Bearer <key>` | MCP Streamable HTTP, stateless, JSON responses. |
| `POST /mcp/u/:key` | key in path | Same, for connectors that cannot send headers. |
| `GET`/`DELETE /mcp` | | 405 (no sessions, no SSE stream). |

The key routes refuse an operator-view token (`via: "operations"`) with 403.
A key belongs to the client alone.

## Tools

Reads: `get_overview`, `list_jobs`, `get_job`, `get_profile`, `get_plan_usage`, `list_documents`.
Writes: `add_job`, `update_job_status`, `remove_job` (reason required), `update_profile` (job preferences and links only).

Writes run through the portal's own controllers in-process (`src/mcp/invokeHandlers.js`), so they keep the same duplicate, plan-cap, exclusion, sponsor and removal-limit rules.
They also fire the same Discord and AI-summary side effects.

## Security model

- Identity comes only from the key. No tool takes an email, and every query is pinned to `userID` of the key's owner.
- Only a SHA-256 of the key is stored (`mcpapikeys.keyHash`, unique). 256 random bits make a slow hash unnecessary.
- Reads return allowlisted fields. `aiDecision`, operator removal notes, extension codes, SSN, DOB, the OpenAI key and portfolio links (operator-only on the portal) never leave the server.
- Limits: 30 bad keys per IP per 15 minutes, 120 requests per key per minute (in-memory, per process).
- The URL form puts the key in the request path. The dev request logger redacts it, but a reverse proxy access log would record it. If nginx logs paths for this host, exclude `/mcp/u/` or log `$uri` without it.

## Code

- `src/mcp/server.js`: auth, rate limits, tool registration, transport.
- `src/mcp/userTools.js`: tool bodies.
- `Controllers/McpKeys.js`, `Schema_Models/McpApiKey.js`, `Utils/mcpApiKey.js`: keys.
- Tests: `Utils/__tests__/mcpServer.test.mjs`.
