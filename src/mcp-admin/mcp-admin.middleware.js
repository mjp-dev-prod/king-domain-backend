// Auth for the isolated /api/mcp-admin/* namespace only.
//
// Deliberately NOT built on top of the session-cookie admin auth
// (admin/routes.js's requireAdmin) — that's shared by the entire dashboard,
// so extending it to recognize a second token type would risk that token
// working somewhere it shouldn't. This middleware checks one static bearer
// secret and is wired ONLY into mcp-admin.routes.js, so a leaked
// MCP_ADMIN_API_TOKEN can only ever be used against this one route
// namespace, never the session-based admin routes or the public /waitlist
// endpoint.
function requireMcpToken(req, res, next) {
  const expected = process.env.MCP_ADMIN_API_TOKEN;
  if (!expected) {
    console.error("[mcp-admin] MCP_ADMIN_API_TOKEN is not set — refusing all requests to this namespace.");
    return res.status(503).json({ error: "MCP admin namespace not configured." });
  }

  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  next();
}

module.exports = { requireMcpToken };
