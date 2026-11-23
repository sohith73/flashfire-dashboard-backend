// FlashFire MCP server: lets a client connect Claude to their own FlashFire
// account and do what they can do on the portal (see userTools.js).
//
//   POST /mcp              Authorization: Bearer ffmcp_...   (Claude Code, Claude Desktop config)
//   POST /mcp/u/:key       key in the URL                     (claude.ai / Claude Desktop "Add custom connector",
//                                                              which cannot send headers)
//   GET, DELETE            405: the server is stateless and has no SSE stream to resume.
//
// Stateless Streamable HTTP: every POST builds a fresh McpServer bound to the
// key's owner, answers, and is thrown away. No session lives in memory, so it
// works the same behind PM2 cluster mode or several instances.
//
// The key is the only identity. It is looked up by SHA-256, must not be
// revoked, and its owner must still be a client account. No tool takes an
// email argument, so a key can never act on anyone else's data.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { McpApiKey } from "../../Schema_Models/McpApiKey.js";
import { findClientUser } from "./clientUser.js";
import { hashMcpKey, isMcpKeyShape } from "../../Utils/mcpApiKey.js";
import { createLoginLimiter } from "../../Utils/speedyApplyAccess.js";
import {
  ToolError,
  JOB_STATUSES,
  MOVABLE_STATUSES,
  getOverview,
  getPlanUsage,
  listJobs,
  getJob,
  getProfile,
  listDocuments,
  addJob,
  updateJobStatus,
  removeJob,
  updateProfile,
} from "./userTools.js";

export const SERVER_INFO = { name: "flashfire", version: "1.0.0" };

// Wrong keys: 30 per IP in 15 minutes, then 429 until the window clears.
const badKeyLimiter = createLoginLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
// Good keys: 120 requests a minute each. Claude makes a few calls per answer;
// this only stops a runaway loop.
const KEY_RATE_MAX = 120;
const keyRateLimiter = createLoginLimiter({ max: KEY_RATE_MAX, windowMs: 60 * 1000 });
// lastUsedAt is for the "last used" column, not an audit log. Writing it at
// most every 5 minutes keeps a busy key from turning every call into a write.
const LAST_USED_EVERY_MS = 5 * 60 * 1000;

function jsonRpcError(res, status, code, message, headers = {}) {
  res.set({ "Cache-Control": "no-store", ...headers });
  return res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function presentedKey(req) {
  if (req.params?.key) return String(req.params.key);
  const header = req.headers?.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Resolves the key to its owner, or answers the request and returns null.
export async function authenticateMcpKey(req, res) {
  const ip = req.ip || "unknown";
  const wait = badKeyLimiter.check(ip);
  if (wait) {
    jsonRpcError(res, 429, -32000, "Too many invalid keys from this address. Try again later.", { "Retry-After": String(wait) });
    return null;
  }

  const key = presentedKey(req);
  const refuse = () => {
    badKeyLimiter.fail(ip);
    jsonRpcError(res, 401, -32001, "Missing or invalid FlashFire key. Make a new one in FlashFire > Profile > Connect to Claude.", {
      "WWW-Authenticate": 'Bearer realm="flashfire-mcp"',
    });
    return null;
  };
  if (!isMcpKeyShape(key)) return refuse();

  const doc = await McpApiKey.findOne({ keyHash: hashMcpKey(key), revokedAt: null }).lean();
  if (!doc) return refuse();

  const user = await findClientUser(doc.email, "email name");
  if (!user) return refuse();

  const rateKey = String(doc._id);
  const rateWait = keyRateLimiter.check(rateKey);
  if (rateWait) {
    jsonRpcError(res, 429, -32000, `Rate limit: ${KEY_RATE_MAX} requests a minute per key.`, { "Retry-After": String(rateWait) });
    return null;
  }
  keyRateLimiter.fail(rateKey); // counts the request; the limiter is a sliding window

  if (!doc.lastUsedAt || Date.now() - new Date(doc.lastUsedAt).getTime() > LAST_USED_EVERY_MS) {
    McpApiKey.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch((err) =>
      console.error("[mcp] lastUsedAt update failed:", err?.message || err)
    );
  }

  return {
    keyId: rateKey,
    email: doc.email,
    accountEmail: user.email,
    name: user.name || user.email,
  };
}

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

// Wraps a tool body: ToolError becomes a tool error Claude shows the client,
// anything else is logged and reported without internals.
function run(ctx, toolName, fn) {
  return async (args) => {
    try {
      return text(await fn(ctx, args || {}));
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
      console.error(`[mcp] ${toolName} failed for ${ctx.email}:`, err?.stack || err);
      return { isError: true, content: [{ type: "text", text: "FlashFire hit an error running that. Try again in a minute." }] };
    }
  };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildMcpServer(ctx) {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      `You are connected to the FlashFire job-search account of ${ctx.name}. ` +
      "FlashFire's team applies to jobs for this client; the board tracks every job through saved, applied, interviewing, offer, rejected and removed. " +
      "Use get_overview first for a summary. Job IDs come from list_jobs. " +
      "Removing a job needs a reason, which also teaches FlashFire what to avoid, and each client has a limited number of removals: confirm with the user before removing.",
  });

  server.registerTool(
    "get_overview",
    {
      title: "Account overview",
      description: "Summary of the FlashFire account: job counts per status, plan usage (applications used and left), and removals left.",
      annotations: READ,
    },
    run(ctx, "get_overview", getOverview)
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description: "Jobs on the client's FlashFire board, most recent activity first. Filter by status or search by job title or company.",
      inputSchema: {
        status: z.enum(JOB_STATUSES).optional().describe("Only jobs in this column."),
        search: z.string().max(100).optional().describe("Matches job title or company name, case-insensitive."),
        limit: z.number().int().min(1).max(100).default(25).describe("How many to return (max 100)."),
        offset: z.number().int().min(0).default(0).describe("Skip this many, for paging."),
      },
      annotations: READ,
    },
    run(ctx, "list_jobs", listJobs)
  );

  server.registerTool(
    "get_job",
    {
      title: "Job details",
      description: "Full details of one job: description, status history, attachments and, for removed jobs, the removal reason.",
      inputSchema: { jobID: z.string().min(1).max(40).describe("The jobID from list_jobs.") },
      annotations: READ,
    },
    run(ctx, "get_job", getJob)
  );

  server.registerTool(
    "get_profile",
    {
      title: "Profile",
      description: "The client's FlashFire profile: contact details, education, target roles, locations, companies, salary and links.",
      annotations: READ,
    },
    run(ctx, "get_profile", getProfile)
  );

  server.registerTool(
    "get_plan_usage",
    {
      title: "Plan usage",
      description: "How many applications the client's plan allows, how many are used, and how many are left.",
      annotations: READ,
    },
    run(ctx, "get_plan_usage", getPlanUsage)
  );

  server.registerTool(
    "list_documents",
    {
      title: "Documents",
      description: "Links to the client's base resume, optimized resumes, cover letters and transcripts.",
      annotations: READ,
    },
    run(ctx, "list_documents", listDocuments)
  );

  server.registerTool(
    "add_job",
    {
      title: "Add a job",
      description:
        "Add a job to the client's board, like the Add Jobs button on the portal. Use the employer's own posting URL, not a job-board link. Duplicates and plan limits are refused with a reason.",
      inputSchema: {
        jobTitle: z.string().trim().min(1).max(50).describe("Job title, at most 50 characters."),
        companyName: z.string().trim().min(1).max(120),
        joblink: z.string().trim().url().max(2000).describe("Employer posting URL."),
        jobDescription: z.string().max(50000).optional(),
        jobLocation: z.string().max(200).optional(),
        status: z.enum(MOVABLE_STATUSES).default("saved").describe("Column to add it to."),
      },
      annotations: WRITE,
    },
    run(ctx, "add_job", addJob)
  );

  server.registerTool(
    "update_job_status",
    {
      title: "Move a job",
      description:
        "Move a job to another column (saved, applied, interviewing, offer, rejected), like dragging the card on the portal. Moving a removed job back counts against the plan again. To remove a job use remove_job.",
      inputSchema: {
        jobID: z.string().min(1).max(40),
        status: z.enum(MOVABLE_STATUSES),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    run(ctx, "update_job_status", updateJobStatus)
  );

  server.registerTool(
    "remove_job",
    {
      title: "Remove a job",
      description:
        "Move a job to Removed with the client's reason. The reason teaches FlashFire which jobs to skip. Each client has a limited number of removals, so confirm with the user first.",
      inputSchema: {
        jobID: z.string().min(1).max(40),
        reason: z.string().trim().min(3).max(1000).describe("Why this job is not a fit, in the client's words."),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    run(ctx, "remove_job", removeJob)
  );

  server.registerTool(
    "update_profile",
    {
      title: "Update profile",
      description:
        "Change the client's job preferences and links. Only the fields passed are changed. List fields replace the whole list, so read get_profile first and send the full new list.",
      inputSchema: {
        preferredRoles: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
        preferredLocations: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
        targetCompanies: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        employmentTypes: z.array(z.enum(["Full-time", "Part-time", "Contract", "Internship"])).min(1).optional(),
        experienceLevel: z.enum(["Entry Level", "Mid Level", "Senior Level", "Executive"]).optional(),
        yearsOfExperience: z.number().min(0).max(60).optional(),
        expectedSalaryRange: z.string().trim().max(100).optional(),
        availabilityNote: z.string().trim().max(500).optional(),
        contactNumber: z.string().trim().max(30).optional(),
        linkedinUrl: z.string().trim().url().max(500).optional(),
        githubUrl: z.string().trim().url().max(500).optional(),
        portfolioUrl: z.string().trim().url().max(500).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    run(ctx, "update_profile", updateProfile)
  );

  return server;
}

// POST /mcp and POST /mcp/u/:key
export async function handleMcpPost(req, res) {
  let ctx;
  try {
    ctx = await authenticateMcpKey(req, res);
  } catch (err) {
    console.error("[mcp] auth failed:", err?.stack || err);
    return jsonRpcError(res, 500, -32603, "FlashFire could not check the key. Try again shortly.");
  }
  if (!ctx) return;

  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err?.stack || err);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
  }
}

// GET/DELETE: nothing to stream or end in stateless mode.
export function handleMcpMethodNotAllowed(req, res) {
  return jsonRpcError(res, 405, -32000, "Method not allowed. Use POST.", { Allow: "POST" });
}
