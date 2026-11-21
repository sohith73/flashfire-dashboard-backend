// Run the second-stage judge on the operator's own machine, with Claude.
//
// The worker code is the SAME one the server runs (src/services/secondJudgeWorker.js):
// same scraper, same prompt, same freshness/location rules, same writes to
// jobdbs. Only the model behind it changes - it talks to a local OpenAI-style
// endpoint (claude_judge/proxy.py) instead of api.openai.com.
//
//   MONGODB_URI=... node scripts/localSecondJudge.mjs
//
// Optional env: SECOND_JUDGE_LLM_URL (default http://127.0.0.1:8790/v1/chat/completions),
// OPENAI_JUDGE_MODEL (name stored on results, default claude-haiku),
// IDLE_EXIT_MIN (stop after this many minutes with nothing pending; 0 = never, default 0).
// Turn the server worker off with SECOND_JUDGE_ENABLED=false on Render, or both will run.
import mongoose from "mongoose";

process.env.SECOND_JUDGE_LLM_URL ||= "http://127.0.0.1:8790/v1/chat/completions";
process.env.OPENAI_JUDGE_MODEL ||= "claude-haiku";
process.env.SECOND_JUDGE_OPENAI_TIMEOUT_MS ||= "240000";
process.env.SECOND_JUDGE_CONCURRENCY ||= "4";
process.env.SECOND_JUDGE_ENABLED = "true";
// Boot-time legacy sweeps are the server's job, not this machine's.
process.env.SECOND_JUDGE_REQUEUE_LEGACY_FLAGS ||= "false";
process.env.SECOND_JUDGE_AUDIT_LEGACY_REMOVALS ||= "false";

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI is not set"); process.exit(1); }
await mongoose.connect(uri);
console.log("[local second judge] connected; model:", process.env.OPENAI_JUDGE_MODEL, "-> ", process.env.SECOND_JUDGE_LLM_URL);

const { startSecondJudgeWorker, getSecondJudgeStatus } = await import("../src/services/secondJudgeWorker.js");
const { JobModel } = await import("../Schema_Models/JobModel.js");
startSecondJudgeWorker();

const idleMin = Number(process.env.IDLE_EXIT_MIN || 0);
let idleSince = null;
setInterval(async () => {
  const pending = await JobModel.countDocuments({ "secondJudge.status": { $in: ["pending", "processing"] } });
  console.log(new Date().toISOString().slice(11, 19), "pending/processing:", pending, "in flight:", getSecondJudgeStatus().inFlight);
  if (pending === 0) {
    idleSince ??= Date.now();
    if (idleMin && Date.now() - idleSince > idleMin * 60000) { console.log("idle - exiting"); process.exit(0); }
  } else idleSince = null;
}, 60000);
