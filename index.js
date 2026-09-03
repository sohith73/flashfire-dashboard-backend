// import express from "express";
// import cors from "cors";
// import dotenv from "dotenv";
// import helmet from "helmet";
// import rateLimit from "express-rate-limit";
// import connectDB from "./Utils/ConnectDB.js";
// import Routes from "./Routes.js";

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 8001;
// const NODE_ENV = process.env.NODE_ENV || "development";

// // Security middleware
// app.use(helmet({
//   contentSecurityPolicy: {
//     directives: {
//       defaultSrc: ["'self'"],
//       styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
//       fontSrc: ["'self'", "https://fonts.gstatic.com"],
//       imgSrc: ["'self'", "data:", "https:", "blob:"],
//       scriptSrc: ["'self'"],
//       connectSrc: ["'self'", "https://api.cloudinary.com", "https://api.openai.com"],
//     },
//   },
// }));

// // CORS configuration
// const corsOptions = {
//   origin: function (origin, callback) {
//     const allowedOrigins = NODE_ENV === "production" 
//       ? [
//           "https://portal.flashfirejobs.com",
//           "https://www.portal.flashfirejobs.com",
//           "https://flashfire-dashboard-frontend.vercel.app",
//           "https://flashfire-dashboard.vercel.app",
//           ...(process.env.ALLOWED_ORIGINS?.split(",") || [])
//         ]
//       : ["http://localhost:3000", "http://localhost:5173"];
    
//     // Allow requests with no origin (like mobile apps or curl requests)
//     if (!origin) return callback(null, true);
    
//     if (allowedOrigins.indexOf(origin) !== -1) {
//       callback(null, true);
//     } else {
//       console.log(`CORS blocked origin: ${origin}`);
//       console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
//       callback(new Error('Not allowed by CORS'));
//     }
//   },
//   credentials: true,
//   optionsSuccessStatus: 200,
//   methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//   allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
// };

// app.use(cors(corsOptions));

// // Rate limiting
// const limiter = rateLimit({
//   windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
//   max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
//   message: {
//     error: "Too many requests from this IP, please try again later.",
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// app.use(limiter);

// // Body parsing middleware
// app.use(express.json({ limit: "50mb" }));
// app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// // Request logging middleware (only in development or for important routes)
// if (NODE_ENV === "development") {
//   app.use((req, res, next) => {
//     const timestamp = new Date().toISOString();
//     console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
//     next();
//   });
// }

// // Routes
// app.use("/", Routes);

// // Health check endpoint
// app.get("/health", (req, res) => {
//   res.json({ 
//     status: "OK", 
//     message: "Server is running",
//     environment: NODE_ENV,
//     timestamp: new Date().toISOString(),
//     uptime: process.uptime(),
//     port: PORT
//   });
// });

// // Root endpoint for Render health checks
// app.get("/", (req, res) => {
//   res.json({ 
//     message: "FlashFire Dashboard API",
//     status: "running",
//     environment: NODE_ENV,
//     timestamp: new Date().toISOString()
//   });
// });

// // 404 handler
// app.use("*", (req, res) => {
//   res.status(404).json({ error: "Route not found" });
// });

// // Global error handler
// app.use((err, req, res, next) => {
//   console.error("Global error handler:", err);
  
//   const statusCode = err.statusCode || 500;
//   const message = NODE_ENV === "production" 
//     ? "Internal server error" 
//     : err.message || "Something went wrong";
  
//   res.status(statusCode).json({
//     error: message,
//     ...(NODE_ENV === "development" && { stack: err.stack })
//   });
// });

// // Connect to database
// connectDB().then(() => {
//   console.log("✅ Database connected successfully");
// }).catch((error) => {
//   console.error("❌ Database connection failed:", error);
//   process.exit(1);
// });

// app.listen(PORT, () => {
//   console.log(`🚀 Server is running on port ${PORT} in ${NODE_ENV} mode`);
//   console.log(`📊 Health check available at http://localhost:${PORT}/health`);
//   console.log(`🌐 API available at http://localhost:${PORT}`);
// });



import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import mongoose from "mongoose";
import cron from "node-cron";
import connectDB from "./Utils/ConnectDB.js";
import Routes from "./Routes.js";
import { runRecruiterAutomationDailyJob } from "./Controllers/GmailRouter.js";
import { startSummarySweepWorker } from "./src/services/summarySweepWorker.js";
import { startSecondJudgeWorker } from "./src/services/secondJudgeWorker.js";
import { startMailPollWorker, isMailPollEnabled } from "./src/services/mailPollWorker.js";
import { sendDailySummary } from "./src/services/mailClientMonitor.js";
import { startOnboardingMailWorker } from "./src/services/onboardingMailWorker.js";
import { startClientReminderWorker } from "./src/services/clientReminderWorker.js";
import { startScrapeCostSnapshotWorker } from "./Utils/scrapeCostNotifier.js";
import { startAutoOptimizationWorker } from "./src/services/autoOptimizationWorker.js";
import { geoStats } from "./Utils/ipGeo.js";
import { refreshOverrides } from "./Utils/ipGeoOverrides.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8086;
const NODE_ENV = process.env.NODE_ENV || "development";

// Trust proxy configuration for cloud deployments (Render, Vercel, etc.)
app.set('trust proxy', 1);

console.log(`🚀 Starting server with NODE_ENV: ${NODE_ENV}`);
console.log(`🌐 Server will run on port: ${PORT}`);

// CORS configuration - MUST come before other middleware
//const corsOptions = {
  //origin: function (origin, callback) {
    //const allowedOrigins = NODE_ENV === "production" 
     // ? [
       //   "https://portal.flashfirejobs.com",
         // "http://localhost:3000",
         // "https://www.portal.flashfirejobs.com",
       //   "https://flashfire-dashboard-frontend.vercel.app",
         // "chrome://extensions/?id=feekbkgobkhnfchgngipimimiiglgpnj",
         // "https://flashfire-dashboard.vercel.app",
         // ...(process.env.ALLOWED_ORIGINS?.split(",") || [])
       // ]
    //  : ["http://localhost:3000"];
    
   // console.log(`CORS check - Origin: ${origin}, NODE_ENV: ${NODE_ENV}`);
   // console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
    
    // Allow requests with no origin (like mobile apps or curl requests)
   // if (!origin) {
     // console.log('CORS: Allowing request with no origin');
     // return callback(null, true);
   // }
    
  //  if (allowedOrigins.indexOf(origin) !== -1) {
    //  console.log(`CORS: Allowing origin ${origin}`);
     // callback(null, true);
   // } else {
     // console.log(`CORS blocked origin: ${origin}`);
   //   callback(new Error('Not allowed by CORS'));
    //}
 // },
//  credentials: true,
//  optionsSuccessStatus: 200,
//  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
//  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Origin", "Accept"],
//  exposedHeaders: ["Content-Length", "X-Requested-With"],
  //preflightContinue: false,
 // maxAge: 86400 // 24 hours
//};

// Apply CORS FIRST, before any other middleware
//app.use(cors());

// Security middleware
// app.use(helmet({
//   contentSecurityPolicy: {
//     directives: {
//       defaultSrc: ["'self'"],
//       styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
//       fontSrc: ["'self'", "https://fonts.gstatic.com"],
//       imgSrc: ["'self'", "data:", "https:", "blob:"],
//       scriptSrc: ["'self'"],
//       connectSrc: ["'self'", "https://api.cloudinary.com", "https://api.openai.com"],
//     },
//   },
// }));

// Open CORS policy (temporary): allow all origins
app.use(cors());
app.options("*", cors());

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "https://api.cloudinary.com", "https://api.openai.com"],
    },
  },
}));
// ── Stripe webhook — MUST be before express.json() to preserve raw body ──
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const discordUrl = process.env.DISCORD_STRIPE_WEBHOOK_URL;

  if (!stripeSecret || !webhookSecret) {
    console.error("Stripe keys not configured");
    return res.status(500).send("Stripe not configured");
  }

  const stripe = new Stripe(stripeSecret);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object;
  const email = (session.client_reference_id || session.customer_details?.email || "").toLowerCase();
  const metadata = session.metadata || {};
  const type = metadata.type;
  const planTarget = metadata.plan;
  const addonApps = metadata.addon;
  const currency = (session.currency || "usd").toUpperCase();
  const amountPaid = ((session.amount_total || 0) / 100).toFixed(2);
  const currentDate = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });

  if (!email) {
    console.error("Stripe webhook: no email found");
    return res.status(200).json({ received: true, warning: "no email" });
  }

  try {
    const { UserModel } = await import("./Schema_Models/UserModel.js");

    const user = await UserModel.findOne({ email });
    if (!user) {
      console.error(`Stripe webhook: user not found for ${email}`);
      return res.status(200).json({ received: true, warning: "user not found" });
    }

    if (type === "upgrade" && planTarget) {
      const planLimits = { prime: 160, ignite: 250, professional: 500, executive: 1200 };
      const planKey = planTarget.toLowerCase();
      const capitalizedPlan = planKey.charAt(0).toUpperCase() + planKey.slice(1);
      const planLimit = planLimits[planKey] || null;

      await UserModel.updateOne(
        { email },
        { $set: { planType: capitalizedPlan, planLimit, amountPaid, updatedAt: currentDate } }
      );
      console.log(`✅ Stripe webhook: upgraded ${email} to ${capitalizedPlan}`);

      if (discordUrl) {
        await fetch(discordUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `✅ **Plan Upgrade via Stripe**\n📧 ${email}\n📦 → ${capitalizedPlan}\n💰 ${currency} ${amountPaid}` }),
        }).catch(() => {});
      }

    } else if (type === "addon" && addonApps) {
      const newAddon = { type: addonApps, price: parseFloat(amountPaid), currency, addedAt: currentDate };
      const currentPaid = parseFloat(user.amountPaid?.replace(/[^0-9.]/g, "") || "0");
      const newTotal = (currentPaid + parseFloat(amountPaid)).toFixed(2);

      await UserModel.updateOne(
        { email },
        { $push: { addons: newAddon }, $set: { amountPaid: newTotal } }
      );
      console.log(`✅ Stripe webhook: added +${addonApps} addon to ${email}`);

      if (discordUrl) {
        await fetch(discordUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `✅ **Add-On Purchase via Stripe**\n📧 ${email}\n➕ +${addonApps} applications\n💰 ${currency} ${amountPaid}` }),
        }).catch(() => {});
      }

    } else {
      console.warn(`Stripe webhook: unhandled metadata type="${type}" plan="${planTarget}" addon="${addonApps}"`);
    }

  } catch (err) {
    console.error("Stripe webhook processing error:", err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
});

// Body parsing middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request logging middleware (only in development or for important routes)
if (NODE_ENV === "development") {
  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
    next();
  });
}

// Health check endpoint (before DB check so it's always accessible)
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Server is running",
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    port: PORT,
    // Cache hit rates and override count for the IP→location resolver. If
    // `resolved` climbs while `dbHits` stays flat the shared cache is not
    // being written and the providers are being hammered.
    geo: geoStats()
  });
});

// CORS test endpoint (before DB check so it's always accessible)
app.get("/cors-test", (req, res) => {
  res.json({ 
    message: "CORS test successful",
    origin: req.headers.origin,
    cors: "working",
    timestamp: new Date().toISOString()
  });
});

// Protect routes until DB is connected to avoid Mongoose buffering timeouts
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database not connected. Please try again in a moment.",
    });
  }
  next();
});

// Routes
app.use("/", Routes);

// Root endpoint for Render health checks
app.get("/", (req, res) => {
  res.json({ 
    message: "FlashFire Dashboard API",
    status: "running",
    environment: NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  
  const statusCode = err.statusCode || 500;
  const message = NODE_ENV === "production" 
    ? "Internal server error" 
    : err.message || "Something went wrong";
  
  res.status(statusCode).json({
    error: message,
    ...(NODE_ENV === "development" && { stack: err.stack })
  });
});

// Connect to database BEFORE starting the server
(async () => {
  try {
    await connectDB();
    console.log("✅ Database connected successfully");

    // All scheduled workers run on first PM2 cluster instance only to avoid
    // duplicate cron fires when running in cluster mode (instances: 'max').
    const instanceId = process.env.NODE_APP_INSTANCE || '0';
    if (instanceId === '0') {
      startAutoOptimizationWorker();
      // Summary sweep: every 30 min, rebuild stale + missing summaries so the
      // grader is never working off an outdated brief. Tagged source field
      // [auto:cron-sweep] so AI Summaries UI shows the auto origin.
      startSummarySweepWorker();
      // Second-stage screening: opens the real employer site for each
      // extension-pushed job, re-judges the full posting against the client
      // profile, and FLAGS mismatches for operator review (does not remove).
      // DB-polled, no Redis.
      startSecondJudgeWorker();

      // Onboarding email sequence: when a client's FIRST job hits "Applied",
      // email their payment address (base résumé / cover letter / LinkedIn, plan-gated,
      // ~90 min apart) over SMTP. Backfills existing applied-clients as skipped
      // on first run so only future first-applications ever fire.
      startOnboardingMailWorker();

      // Client reminders: every 5 min, deliver whatever the Operations >
      // Client Reminders tab has configured per client - daily/weekly/monthly
      // activity reports, interview pipeline, plan usage, milestones and the
      // internal no-activity alert. Goes to the client's payment email over
      // SMTP and/or a per-client Mattermost webhook.
      //
      // Two things worth knowing before you touch this line:
      //   - Gated on CLIENT_REMINDERS_ENABLED ('1' forces on, '0' forces off,
      //     default on Render only). A laptop sharing the prod DB stays quiet,
      //     and the worker logs which state it resolved to at startup.
      //   - An activity-gated report with nothing to report is NOT sent. The
      //     silence is the feature; see decideDelivery() in the worker.
      startClientReminderWorker();

      // Scrape-cost daily snapshot: every 10 min, roll today's scrape-pipeline
      // spend (stage 1 + stage 2 + jobs scraped) into a dated ScrapeCostDaily
      // row so the admin dashboard can graph daily and monthly spend. Runs
      // unconditionally (not gated on a Discord milestone) so low-volume days
      // still get a row.
      startScrapeCostSnapshotWorker();

      // Inbound mail pipeline: hourly, reads each connected client mailbox,
      // summarizes new INBOX mail with gpt-4o-mini, and posts a rich embed
      // (summary + links + .txt attachment) to Discord.
      //
      // DISABLED by default — we do not want client mail captured or forwarded
      // to Discord. This call is a no-op unless MAIL_POLL_ENABLED=1. Left in
      // place (rather than deleted) so re-enabling is one env var, and so the
      // startup log states plainly that the pipeline is off.
      startMailPollWorker();

      // Recruiter email automation — fires at 11 PM IST every night.
      // Must stay inside the instanceId === '0' guard so only one process
      // runs it even when PM2 spawns multiple cluster workers.
      cron.schedule(
        "5 23 * * *",
        async () => {
          try {
            await runRecruiterAutomationDailyJob();
          } catch (error) {
            console.error("Recruiter automation job failed", error);
          }
        },
        {
          timezone: "Asia/Kolkata"
        }
      );
      console.log("[RecruiterAutomation] Nightly cron registered on instance 0 (11:05 PM IST)");

      // Daily mail summary — 5 AM IST. Header with 24h totals + one message per
      // useful mail (interview / assignment / offer) to the single mail channel.
      // Runs only where the poll runs (auto-on on Render / MAIL_POLL_ENABLED=1).
      if (isMailPollEnabled()) {
        cron.schedule(
          "0 5 * * *", // 5 AM IST daily
          async () => {
            try {
              await sendDailySummary();
            } catch (error) {
              console.error("[mail-monitor] daily summary job failed", error);
            }
          },
          { timezone: "Asia/Kolkata" }
        );
        console.log("[mail-monitor] Daily summary cron registered on instance 0 (5 AM IST)");
      } else {
        console.log("[mail-monitor] Daily summary cron NOT registered (mail poll disabled)");
      }
    } else {
      console.log(`[AutoOptWorker] Skipping on cluster instance ${instanceId}`);
      console.log(`[summary-sweep] Skipping on cluster instance ${instanceId}`);
      console.log(`[mail-poll] Skipping on cluster instance ${instanceId}`);
      console.log(`[RecruiterAutomation] Skipping cron on cluster instance ${instanceId}`);
    }

    // Load pinned IP overrides before serving so the first login is matched
    // against them. Failure only logs — the resolver refreshes on its own tick.
    await refreshOverrides();

    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT} in ${NODE_ENV} mode`);
      console.log(`📊 Health check available at http://localhost:${PORT}/health`);
      console.log(`🌐 API available at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
})();


