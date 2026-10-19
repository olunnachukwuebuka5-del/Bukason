// netlify/functions/gather.js
// Admin-only endpoint used by admin.html. Every request needs the
// x-admin-key header to match ADMIN_KEY.
//
// Actions (JSON body): overview | gather | add-topics | run-queue | suggest-topics | set-auto | retry-failed

const core = require("../lib/gather-core.js");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return core.reply(405, { error: "Use POST." });

  const problem = core.envProblem();
  if (problem) return core.reply(500, { error: problem });

  if (!core.keyMatches(event.headers["x-admin-key"], process.env.ADMIN_KEY)) {
    return core.reply(401, { error: "Wrong admin key." });
  }

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return core.reply(400, { error: "Request body was not valid JSON." }); }

  const action = input.action || "gather";

  try {
    if (action === "overview") {
      return core.reply(200, await core.overview());
    }

    if (action === "add-topics") {
      return core.reply(200, await core.addTopics(input.topics, input.mode, input.useWeb === true));
    }

    if (action === "run-queue") {
      return core.reply(200, await core.runQueue(input.max || 1, { count: 5, budgetMs: 8000 }));
    }

    if (action === "suggest-topics") {
      return core.reply(200, await core.suggestTopics(input.area, input.count));
    }

    if (action === "set-auto") {
      await core.setSetting("auto_gather_paused", input.paused === true ? "true" : "false");
      return core.reply(200, { autoPaused: input.paused === true });
    }

    if (action === "retry-failed") {
      return core.reply(200, await core.retryFailed());
    }

    if (action === "gather") {
      const topic = String(input.topic || "").trim().slice(0, 200);
      if (topic.length < 3) return core.reply(400, { error: "Type a topic (at least 3 characters)." });

      const count = Math.min(Math.max(parseInt(input.count, 10) || 6, 1), 15);
      const mode = ["academics", "business", "general"].includes(input.mode) ? input.mode : "general";
      const useWeb = input.useWeb === true;

      const { entries, provider, webUsed, failures } = await core.generateEntries(topic, count, mode, useWeb);
      const sv = await core.saveEntries(entries);
      const saved = sv.saved;
      return core.reply(200, {
        topic, provider, webRequested: useWeb, webUsed,
        requested: count, usable: entries.length,
        added: saved.length, nearDuplicates: sv.nearDuplicates,
        skippedDuplicates: entries.length - sv.nearDuplicates - saved.length,
        earlierFailures: failures,
        questions: saved.map(r => r.question)
      });
    }

    return core.reply(400, { error: "Unknown action." });
  } catch (err) {
    return core.reply(502, { error: err.message || "Something went wrong." });
  }
};
