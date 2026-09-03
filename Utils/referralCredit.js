import { UserModel } from "../Schema_Models/UserModel.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { isSendgridConfigured, sendEmail } from "./sendgridClient.js";

/**
 * Grants a referrer their bonus applications when someone they referred joins
 * a paid plan.
 *
 * The pieces for this already existed and were simply never joined up:
 *   - onboarding stores the referrer's NAME in ProfileModel.referredBy
 *   - UserModel.referrals[] is what the bonus is read from
 *   - dailyCapGuard.computeReferralBonus() turns that into +200 / +300
 *     applications and readPlanCap() stacks it onto the plan cap
 * Nothing ever wrote referrals[], so ops had to add every entry by hand via
 * clients-tracking. Both services point at the same `users` collection, so we
 * write it directly here rather than making an HTTP hop.
 *
 * Deliberate choices:
 *   - Only paid plans credit. The Refer n Earn page promises the bonus when a
 *     friend "joins an eligible plan"; crediting at signup would let anyone
 *     farm bonuses with free accounts.
 *   - A name is matched only when it resolves to exactly one other client.
 *     Zero or several matches are recorded for ops instead of guessed at,
 *     because guessing pays the wrong person.
 *   - Idempotent. The outcome is stamped on the REFERRED client, so re-saving
 *     a plan never double-credits.
 */

// Mirrors REFERRAL_BONUS in dailyCapGuard.js — kept as the eligibility list.
const ELIGIBLE_PLANS = ["Professional", "Executive"];

// Things people type when nobody referred them. The onboarding placeholder
// suggests "None", so honour that rather than hunting for a client called None.
const NO_REFERRER = new Set(["", "none", "n/a", "na", "no", "nil", "-", "self", "nobody"]);

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const norm = (v) => String(v || "").trim();

function planOf(user) {
  const p = norm(user?.planType);
  return ELIGIBLE_PLANS.find((x) => x.toLowerCase() === p.toLowerCase()) || null;
}

async function alertOps(subject, body) {
  const webhook = process.env.REFERRAL_OPS_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{ title: subject, description: body, color: 0xff6b35, timestamp: new Date().toISOString() }],
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.warn("[referralCredit] ops webhook failed:", e?.message || e);
    }
  }
  const to = process.env.REFERRAL_OPS_EMAIL;
  if (to && isSendgridConfigured()) {
    try {
      await sendEmail({ to, subject, text: body });
    } catch (e) {
      console.warn("[referralCredit] ops email failed:", e?.message || e);
    }
  }
}

async function notifyReferrer(referrer, referredName, plan, bonus) {
  // Off unless explicitly enabled, so "credit silently" is a config change.
  if (String(process.env.REFERRAL_NOTIFY_REFERRER).toLowerCase() !== "true") return;
  if (!referrer?.email || !isSendgridConfigured()) return;
  try {
    await sendEmail({
      to: referrer.email,
      subject: `You earned ${bonus} bonus applications`,
      text:
        `Hi ${norm(referrer.name) || "there"},\n\n` +
        `${referredName} joined Flashfire on the ${plan} plan and named you as their referrer.\n` +
        `${bonus} bonus applications have been added to your plan — there is nothing to claim.\n\n` +
        `You can see your running total on the Refer n Earn page.\n`,
    });
  } catch (e) {
    console.warn("[referralCredit] referrer email failed:", e?.message || e);
  }
}

/**
 * @param {string} clientEmail  the person who was referred
 * @returns {Promise<{status: string, detail?: string}>} never throws
 */
export async function creditReferralOnPlan(clientEmail) {
  try {
    const email = norm(clientEmail).toLowerCase();
    if (!email) return { status: "skipped", detail: "no email" };

    const client = await UserModel.findOne({ email }).select(
      "email name planType referralCredit",
    );
    if (!client) return { status: "skipped", detail: "client not found" };

    // Already settled one way or the other — never process twice.
    if (client.referralCredit?.status) {
      return { status: "skipped", detail: `already ${client.referralCredit.status}` };
    }

    const plan = planOf(client);
    if (!plan) return { status: "skipped", detail: "not on an eligible plan yet" };

    const profile = await ProfileModel.findOne({ email }).select("referredBy").lean();
    const referredByName = norm(profile?.referredBy);
    if (!referredByName || NO_REFERRER.has(referredByName.toLowerCase())) {
      return { status: "skipped", detail: "no referrer named" };
    }

    const stamp = async (status, extra = {}) => {
      await UserModel.updateOne(
        { email },
        {
          $set: {
            "referralCredit.referredByName": referredByName,
            "referralCredit.plan": plan,
            "referralCredit.status": status,
            "referralCredit.processedAt": new Date(),
            "referralCredit.referrerEmail": extra.referrerEmail || "",
            "referralCredit.candidates": extra.candidates || [],
          },
        },
      );
    };

    // Exact, case-insensitive name match against other clients.
    const matches = await UserModel.find({
      name: { $regex: new RegExp(`^${escapeRegex(referredByName)}$`, "i") },
      email: { $ne: email },
    })
      .select("email name")
      .lean();

    if (matches.length === 0) {
      await stamp("unmatched");
      await alertOps(
        "Referral could not be matched",
        `${client.name || email} joined on the ${plan} plan and named "${referredByName}" as their referrer, ` +
          `but no client has that name. Nobody has been credited — add the referral by hand if it is legitimate.`,
      );
      return { status: "unmatched" };
    }

    if (matches.length > 1) {
      const candidates = matches.map((m) => m.email);
      await stamp("ambiguous", { candidates });
      await alertOps(
        "Referral is ambiguous",
        `${client.name || email} joined on the ${plan} plan and named "${referredByName}" as their referrer, ` +
          `but ${matches.length} clients share that name:\n${candidates.join("\n")}\n\n` +
          `Nobody has been credited — pick the right one and add it by hand.`,
      );
      return { status: "ambiguous", detail: candidates.join(", ") };
    }

    const referrer = matches[0];

    // Same shape clients-tracking writes, so both paths stay compatible.
    await UserModel.updateOne(
      { email: referrer.email },
      {
        $push: {
          referrals: {
            name: norm(client.name) || email,
            plan,
            notes: `Auto-credited when ${email} joined the ${plan} plan.`,
            createdAt: new Date(),
          },
        },
      },
    );
    await stamp("credited", { referrerEmail: referrer.email });

    const bonus = plan === "Executive" ? 300 : 200;
    await notifyReferrer(referrer, norm(client.name) || email, plan, bonus);

    console.log(
      `[referralCredit] ${referrer.email} +${bonus} applications for referring ${email} (${plan})`,
    );
    return { status: "credited", detail: referrer.email };
  } catch (err) {
    // Never let this break a plan save.
    console.error("[referralCredit] failed:", err?.message || err);
    return { status: "error", detail: err?.message };
  }
}
