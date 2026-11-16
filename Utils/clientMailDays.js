// No client mail on Sundays (bsc, 2026-11-16).
//
// "Sunday" is the IST calendar day, the same clock every mail worker here
// already runs on. 00:00 to 23:59 IST Sunday is Saturday 13:30 to Sunday 13:29
// US Eastern, so the 21:30 IST daily summary that would have landed Sunday
// morning in the US is the one this stops.
//
// What each stream does on a held day:
//   daily summary   (clientReminderWorker)  not sent; Sunday's period is left
//                   unused, so Monday's summary goes out as normal
//   onboarding      (onboardingMailWorker)  steps wait; the first goes out
//                   from Monday 00:00 IST, spacing as usual
//   inbox alerts    (clientMailNotifier)    held without burning a retry; the
//                   retry sweep sends them from Monday 00:00 IST
// Internal mail (the no-activity alert to the team inbox) is not client mail
// and still sends.
//
// clients-tracking keeps its own copy of this rule for the milestone emails
// and the Notifications tab's Scheduled view
// (applications_monitor_backend/utils/clientMailDays.js). Change both.

import { istParts, startOfCalendarDayIST, DAY_MS } from "./istWindow.js";

/** IST weekdays with no client mail. 0 = Sunday. */
export const CLIENT_MAIL_OFF_WEEKDAYS = new Set([0]);

/** Reason recorded when a client mail is held for the day. */
export const CLIENT_MAIL_HOLD_REASON = "sunday_hold";

/** Is `now` on an IST day when client mail is held? */
export function isClientMailOffDay(now = new Date()) {
  return CLIENT_MAIL_OFF_WEEKDAYS.has(istParts(now).weekday);
}

/**
 * The first instant at or after `at` when client mail may go out: `at` itself
 * on a normal day, otherwise 00:00 IST of the next allowed day.
 */
export function nextClientMailInstant(at) {
  let t = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(t.getTime())) return t;
  // Seven steps is enough for any set short of every day being off.
  for (let i = 0; i < 7 && isClientMailOffDay(t); i++) {
    t = new Date(startOfCalendarDayIST(t).getTime() + DAY_MS);
  }
  return t;
}
