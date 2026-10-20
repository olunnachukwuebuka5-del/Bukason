// netlify/functions/auto-gather.js
// Wakes up every few minutes (see netlify.toml). How often it actually
// gathers depends on how much is already saved:
//   fewer than AUTO_FAST_UNTIL entries (default 10,000): every run, ~3 minutes
//   up to AUTO_ENTRY_LIMIT (default 30,000):             about once an hour
//   at the limit:                                         stops
// The Pause button on the admin page also stops it.

const core = require("../lib/gather-core.js");

const FAST_GAP_MS = 60 * 1000;
const HOURLY_GAP_MS = 60 * 60 * 1000;
const JITTER_MS = 30 * 1000; // schedules never fire at the exact second

exports.handler = async () => {
  const problem = core.envProblem();
  if (problem) {
    console.error("auto-gather:", problem);
    return { statusCode: 500, body: problem };
  }
  try {
    if (await core.autoPaused()) {
      return { statusCode: 200, body: "paused from the admin page" };
    }

    const plan = core.autoPlan(await core.knowledgeCount());
    if (plan.mode === "stopped") {
      console.log("auto-gather: stopped, " + plan.total + " entries reached the limit of " + plan.limit);
      return { statusCode: 200, body: "stopped: entry limit reached" };
    }

    const gap = plan.mode === "hourly" ? HOURLY_GAP_MS : FAST_GAP_MS;
    const last = await core.lastActivityAt();
    if (last && Date.now() - last < gap - JITTER_MS) {
      return { statusCode: 200, body: "waiting (" + plan.mode + " mode)" };
    }

    let topUp = null;
    try { topUp = await core.topUpQueue(); }
    catch (e) { console.error("auto-gather: could not suggest topics:", e.message); }

    const result = await core.runQueue(1, { count: 6, budgetMs: 20000 });
    console.log("auto-gather:", JSON.stringify({ mode: plan.mode, topUp, result }));
    return { statusCode: 200, body: JSON.stringify({ mode: plan.mode, topUp, result }) };
  } catch (err) {
    console.error("auto-gather failed:", err);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
