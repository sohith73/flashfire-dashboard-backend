// Run an Express middleware chain in-process and capture what it answers.
//
// The MCP tools write through the very same controllers the dashboard calls
// (CheckForDuplicateJobs -> AddJob, UpdateChanges, Add_Update_Profile), so a
// job added from Claude passes the same duplicate, plan-cap, exclusion and
// removal-limit checks, and fires the same Discord and AI-summary side effects,
// as one added in the portal. Re-implementing those rules here would let the
// two paths drift apart.
//
// The caller builds the request body itself, with the identity pinned to the
// key's owner, so nothing a tool argument says can reach another account.

const DEFAULT_TIMEOUT_MS = 30_000;

export function invokeHandlers(handlers, { body = {}, query = {}, params = {}, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let statusCode = 200;
    const resHeaders = {};

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: statusCode, body: payload });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    // A controller that never answers (some legacy ones only console.log on
    // error) must not hang the MCP request forever.
    const timer = setTimeout(() => fail(new Error("handler_timeout")), timeoutMs);

    const req = { body, query, params, headers, method: "POST", ip: "mcp", get: (h) => headers[String(h).toLowerCase()] };
    const res = {
      get headersSent() {
        return settled;
      },
      status(code) {
        statusCode = code;
        return res;
      },
      set(name, value) {
        if (typeof name === "object") Object.assign(resHeaders, name);
        else resHeaders[name] = value;
        return res;
      },
      setHeader(name, value) {
        resHeaders[name] = value;
        return res;
      },
      json(payload) {
        finish(payload);
        return res;
      },
      send(payload) {
        finish(payload);
        return res;
      },
      end(payload) {
        finish(payload);
        return res;
      },
    };

    let index = 0;
    const next = (err) => {
      if (err) return fail(err);
      const handler = handlers[index++];
      if (!handler) return fail(new Error("handler_chain_ended_without_response"));
      try {
        Promise.resolve(handler(req, res, next)).catch(fail);
      } catch (e) {
        fail(e);
      }
    };
    next();
  });
}
