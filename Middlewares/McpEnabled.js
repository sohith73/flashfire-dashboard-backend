// Off switch for the client MCP server (src/mcp) and its key routes.
//
// The MCP server lets a client drive their account from Claude. It is turned
// off for now: the routes stay registered but answer 503 until
// MCP_SERVER_ENABLED=true is set. Nothing is deleted, so turning it back on is
// one env var and a restart.

export const isMcpEnabled = () => String(process.env.MCP_SERVER_ENABLED || "").trim().toLowerCase() === "true";

export default function McpEnabled(req, res, next) {
  if (isMcpEnabled()) return next();
  const message = "The FlashFire Claude connection is turned off.";
  // /mcp speaks JSON-RPC, so answer it in that shape; /mcp-keys is plain JSON.
  if (req.path.startsWith("/mcp-keys")) {
    return res.status(503).json({ message, code: "MCP_DISABLED" });
  }
  return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
