// netlify/lib/gather-core.js (shared by gather.js and auto-gather.js)
// ------------------------------------------------------------
// YOU call this (from admin.html) while you're online.
// It asks Gemini to produce question+answer entries about a
// topic (optionally using live Google Search), then saves them
// into the Supabase `knowledge` table. Users' phones sync from
// that table later, and answer from their own copy offline.
//
// Netlify environment variables required:
//   ADMIN_KEY            a long secret only you know
//   SUPABASE_URL         https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY the SERVICE ROLE key (never put in frontend)
//   ...and at least one AI key. Providers are tried in this order,
//   the same keys your chat.js already uses:
//   GEMINI_API_KEY, GROQ_API_KEY, NVIDIA_API_KEY,
//   OPENROUTER_API_KEY, CEREBRAS_API_KEY
// Optional:
//   GEMINI_MODEL         defaults to gemini-2.5-flash
// Live web search only works through Gemini. If Gemini is down, the
// backups still write entries, but without web search.
// ------------------------------------------------------------

const crypto = require("crypto");

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function reply(status, body) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify(body) };
}

function keyMatches(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function buildPrompt(topic, count, mode) {
  const audience = mode === "academics"
    ? "Students preparing for school and exams will ask these."
    : mode === "business"
      ? "People starting or running small businesses will ask these."
      : "Everyday people will ask these, about any part of life: school, work, health, money, technology, culture, home and more.";

  return `You are building an offline knowledge pack for BUKASON, a free assistant used by people in Nigeria and beyond.
Topic: "${topic}"
${audience}

Write ${count} distinct question-and-answer entries that people might really ask about this topic.
Rules:
- Answers must be accurate, clear and self-contained: 2 to 5 sentences, plain text only.
- Do not invent facts, dates, prices, statistics or quotes. If you are not sure, leave that entry out.
- Skip anything that changes quickly (current prices, office holders, news) unless you have verified it.
- For health, legal or money questions, give general information only and say when a doctor, lawyer or qualified professional should be consulted.
- "keywords" are 3 to 8 lowercase words or short phrases people might type when asking.
- Return ONLY a JSON array, no markdown, in exactly this shape:
[{"question":"...","keywords":["..."],"answer":"..."}]`;
}

async function askGemini(prompt, useWeb) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 }
  };

  if (useWeb) {
    // Live Google Search. Gemini cannot force JSON mode together with
    // search, so we extract the JSON from the text afterwards.
    body.tools = [{ google_search: {} }];
  } else {
    body.generationConfig.responseMimeType = "application/json";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Gemini error ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty answer.");
  return text;
}

const SYSTEM_JSON = "You output only valid JSON, with no markdown and no commentary.";

async function openAICompatible(url, key, model, prompt) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_JSON },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 120);
    throw new Error(`${model} HTTP ${res.status} ${detail}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${model} returned nothing`);
  return text;
}

async function openRouterFreeModels(key) {
  // Free models rotate often, so look up what is free right now.
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || [])
    .filter(m => m.id && m.id.endsWith(":free"))
    .map(m => m.id)
    .slice(0, 3);
}

// Tries each model in turn; returns the first usable text.
async function firstWorking(models, call) {
  const errors = [];
  for (const model of models) {
    try { return await call(model); }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(" | ") || "no models available");
}

// Build the list of AI providers that have a key set, in order.
function buildProviders(prompt, useWeb) {
  const env = process.env;
  const list = [];

  if (env.GEMINI_API_KEY) {
    list.push({ name: "Gemini", web: useWeb, run: () => askGemini(prompt, useWeb) });
    if (useWeb) {
      list.push({ name: "Gemini", web: false, run: () => askGemini(prompt, false) });
    }
  }
  if (env.GROQ_API_KEY) {
    list.push({ name: "Groq", web: false, run: () => firstWorking(
      ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
      m => openAICompatible("https://api.groq.com/openai/v1/chat/completions", env.GROQ_API_KEY, m, prompt)) });
  }
  if (env.NVIDIA_API_KEY) {
    list.push({ name: "NVIDIA", web: false, run: () => firstWorking(
      ["meta/llama-3.1-8b-instruct", "mistralai/mixtral-8x7b-instruct-v0.1"],
      m => openAICompatible("https://integrate.api.nvidia.com/v1/chat/completions", env.NVIDIA_API_KEY, m, prompt)) });
  }
  if (env.OPENROUTER_API_KEY) {
    list.push({ name: "OpenRouter", web: false, run: async () => firstWorking(
      await openRouterFreeModels(env.OPENROUTER_API_KEY),
      m => openAICompatible("https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_API_KEY, m, prompt)) });
  }
  if (env.CEREBRAS_API_KEY) {
    list.push({ name: "Cerebras", web: false, run: () => firstWorking(
      ["gpt-oss-120b"],
      m => openAICompatible("https://api.cerebras.ai/v1/chat/completions", env.CEREBRAS_API_KEY, m, prompt)) });
  }
  return list;
}

// Try providers until one gives usable entries.
async function generateEntries(topic, count, mode, useWeb) {
  const prompt = buildPrompt(topic, count, mode);
  const providers = buildProviders(prompt, useWeb);
  const failures = [];

  for (const p of providers) {
    try {
      const text = await p.run();
      const entries = cleanEntries(parseEntries(text), topic, mode, p.web);
      if (entries.length) {
        return { entries, provider: p.name, webUsed: p.web, failures };
      }
      failures.push(`${p.name}: no usable entries`);
    } catch (e) {
      failures.push(`${p.name}: ${String(e.message).slice(0, 160)}`);
    }
  }
  const err = new Error("Every AI provider failed. " + failures.join(" || "));
  throw err;
}

function parseEntries(text) {
  // Strip ```json fences if the model added them, then take the
  // outermost [...] block.
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not find a JSON list in the AI reply.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function cleanEntries(raw, topic, mode, useWeb) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const question = String(item?.question || "").trim().slice(0, 300);
    const answer = String(item?.answer || "").trim().slice(0, 1500);
    if (question.length < 8 || answer.length < 20) continue;

    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const keywords = (Array.isArray(item.keywords) ? item.keywords : [])
      .map(k => String(k).toLowerCase().trim())
      .filter(k => k.length > 1 && k.length <= 40)
      .slice(0, 8);

    out.push({
      topic,
      mode,
      question,
      keywords,
      answer,
      source: useWeb ? "ai+web" : "ai"
    });
  }
  return out;
}

async function saveToSupabase(entries) {
  // on_conflict + ignore-duplicates: re-gathering the same topic
  // never overwrites or duplicates existing questions.
  const url = `${process.env.SUPABASE_URL}/rest/v1/knowledge?on_conflict=question`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      Prefer: "resolution=ignore-duplicates,return=representation"
    },
    body: JSON.stringify(entries)
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Supabase error ${res.status}: ${detail}`);
  }
  return res.json(); // only the rows that were actually new
}


// ============================================================
// Supabase helpers (service key, server side only)
// ============================================================

function sbHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}

async function sbFetch(path, options) {
  options = options || {};
  const res = await fetch(process.env.SUPABASE_URL + path, {
    method: options.method || "GET",
    headers: sbHeaders(options.headers),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error("Supabase " + res.status + ": " + detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbCount(path) {
  const res = await fetch(process.env.SUPABASE_URL + path, {
    headers: sbHeaders({ Prefer: "count=exact", Range: "0-0" })
  });
  if (!res.ok) throw new Error("Supabase " + res.status);
  const total = (res.headers.get("content-range") || "").split("/")[1];
  return total && total !== "*" ? parseInt(total, 10) : 0;
}

function envProblem() {
  const missing = ["ADMIN_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"].filter(n => !process.env[n]);
  if (missing.length) return "Missing Netlify environment variables: " + missing.join(", ");
  const aiKeys = ["GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY"];
  if (!aiKeys.some(n => process.env[n])) return "No AI key found. Add at least one of: " + aiKeys.join(", ");
  return null;
}

// ============================================================
// Near-duplicate removal
// ============================================================
// The AI often asks the same thing in different words ("What is rain?" and
// "Explain what rain is"). Exact repeats are already rejected by the database;
// this also drops questions whose key words mostly overlap.

const STOP_WORDS = new Set((
  "a an the is are was were be been am do does did of to in on at for with and or but if so as by from " +
  "it its this that these those what which who whom whose how why when where can could should would " +
  "will shall may might must i me my we our you your he she they them his her their there here than " +
  "then about into out up down over under not no yes please tell explain describe give define mean meaning"
).split(" "));

const NEAR_DUPLICATE_SCORE = 0.65; // share of key words in common (0 to 1)

function contentSet(text) {
  const all = String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const real = all.filter(t => !STOP_WORDS.has(t));
  return new Set(real.length ? real : all);
}

function similarSets(a, b) {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared) >= NEAR_DUPLICATE_SCORE;
}

async function removeNearDuplicates(entries) {
  let dropped = 0;

  // 1. Repeats inside this batch.
  const fresh = [];
  for (const e of entries) {
    const set = contentSet(e.question);
    if (fresh.some(f => similarSets(set, f.set))) { dropped++; continue; }
    fresh.push({ entry: e, set });
  }

  // 2. Repeats of what is already saved (looked up by shared keywords).
  let existing = [];
  try {
    const words = new Set();
    fresh.forEach(f => (f.entry.keywords || []).forEach(w => {
      if (/^[a-z0-9][a-z0-9 \-]{1,38}$/.test(w)) words.add(w);
    }));
    if (words.size) {
      const literal = "{" + Array.from(words).slice(0, 40).map(w => '"' + w + '"').join(",") + "}";
      existing = await sbFetch("/rest/v1/knowledge?select=question&keywords=ov." + encodeURIComponent(literal) + "&limit=1000");
    }
  } catch (e) {
    existing = []; // if the lookup fails, save anyway rather than lose the batch
  }
  const savedSets = (existing || []).map(r => contentSet(r.question));

  const kept = [];
  for (const f of fresh) {
    if (savedSets.some(s => similarSets(f.set, s))) dropped++;
    else kept.push(f.entry);
  }
  return { kept, dropped };
}

// Removes near-duplicates, then saves what is left.
async function saveEntries(entries) {
  const { kept, dropped } = await removeNearDuplicates(entries);
  const saved = kept.length ? await saveToSupabase(kept) : [];
  return { saved, nearDuplicates: dropped };
}

// ============================================================
// How fast automatic gathering runs, based on how much is saved
// ============================================================
// fast: every run (every few minutes). hourly: one run an hour.
// stopped: nothing more is gathered automatically.
// Change with AUTO_FAST_UNTIL and AUTO_ENTRY_LIMIT in Netlify.

function autoPlan(total) {
  const fastUntil = parseInt(process.env.AUTO_FAST_UNTIL, 10) || 10000;
  const limitEnv = parseInt(process.env.AUTO_ENTRY_LIMIT, 10);
  const limit = limitEnv > 0 ? limitEnv : 30000;
  const mode = total >= limit ? "stopped" : total >= fastUntil ? "hourly" : "fast";
  return { mode, total, fastUntil, limit };
}

// ============================================================
// Topic queue (table: gather_topics)
// ============================================================

const MAX_ATTEMPTS = 3;
const STALE_MS = 15 * 60 * 1000; // a topic stuck "running" this long is retried

function normalizeTopics(input) {
  const lines = Array.isArray(input) ? input : String(input || "").split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const t = String(line).replace(/\s+/g, " ").trim().slice(0, 200);
    if (t.length < 3) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 100) break;
  }
  return out;
}

async function addTopics(input, mode, useWeb) {
  const topics = normalizeTopics(input);
  if (!topics.length) throw new Error("No topics found. Type one topic per line.");
  const safeMode = ["academics", "business", "general"].includes(mode) ? mode : "general";
  const rows = topics.map(t => ({ topic: t, mode: safeMode, use_web: !!useWeb }));
  const saved = await sbFetch("/rest/v1/gather_topics?on_conflict=topic", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: rows
  });
  return { submitted: topics.length, added: saved.length, skipped: topics.length - saved.length };
}

async function reclaimStale() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  await sbFetch("/rest/v1/gather_topics?status=eq.running&claimed_at=lt." + encodeURIComponent(cutoff), {
    method: "PATCH",
    body: { status: "pending" }
  });
}

async function claimTopics(n) {
  const pending = await sbFetch(
    "/rest/v1/gather_topics?select=id,topic,mode,use_web,attempts&status=eq.pending&order=created_at.asc&limit=" + n
  );
  const claimed = [];
  for (const row of pending || []) {
    // Only succeeds if it is still pending, so two runs never take the same topic.
    const r = await sbFetch("/rest/v1/gather_topics?id=eq." + row.id + "&status=eq.pending", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: { status: "running", claimed_at: new Date().toISOString() }
    });
    if (r && r.length) claimed.push(row);
  }
  return claimed;
}

async function runQueue(maxTopics, opts) {
  opts = opts || {};
  const budgetMs = opts.budgetMs || 12000;
  const count = opts.count || 5;
  const started = Date.now();

  await reclaimStale();
  const claimed = await claimTopics(Math.min(Math.max(parseInt(maxTopics, 10) || 1, 1), 5));
  const results = [];

  for (const t of claimed) {
    if (results.length && Date.now() - started > budgetMs) {
      // Out of time: hand it back for the next run.
      await sbFetch("/rest/v1/gather_topics?id=eq." + t.id + "&status=eq.running", {
        method: "PATCH", body: { status: "pending" }
      }).catch(() => {});
      continue;
    }
    try {
      const g = await generateEntries(t.topic, count, t.mode || "general", !!t.use_web);
      const sv = await saveEntries(g.entries);
      const saved = sv.saved;
      await sbFetch("/rest/v1/gather_topics?id=eq." + t.id, {
        method: "PATCH",
        body: { status: "done", done_at: new Date().toISOString(), added: saved.length, provider: g.provider, last_error: null }
      });
      results.push({ topic: t.topic, ok: true, added: saved.length, nearDuplicates: sv.nearDuplicates, provider: g.provider });
    } catch (e) {
      const attempts = (t.attempts || 0) + 1;
      const message = String(e.message || e).slice(0, 300);
      await sbFetch("/rest/v1/gather_topics?id=eq." + t.id, {
        method: "PATCH",
        body: { status: attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts: attempts, last_error: message }
      }).catch(() => {});
      results.push({ topic: t.topic, ok: false, error: message });
    }
  }
  return { processed: results.length, waiting: claimed.length === 0, results };
}

// Ask the first provider that works. Used for jobs that are not Q&A entries.
async function askProviders(prompt) {
  const failures = [];
  for (const p of buildProviders(prompt, false)) {
    try {
      return { text: await p.run(), provider: p.name };
    } catch (e) {
      failures.push(p.name + ": " + String(e.message).slice(0, 120));
    }
  }
  throw new Error("Every AI provider failed. " + failures.join(" || "));
}

// Broad subject areas. The server rotates through them so the knowledge
// grows across everything, not just school or business.
const TOPIC_AREAS = [
  "Science and nature", "World history", "Nigerian history and culture",
  "Geography, countries and cities", "Health and wellness basics",
  "Technology and the internet", "Personal finance and saving",
  "Careers and workplace skills", "Citizens' rights and how government works",
  "Food, cooking and nutrition", "Sports and fitness", "Arts, music and film",
  "Language and communication", "Home, family and daily life",
  "Agriculture and the environment", "Mathematics and logic",
  "Small business and entrepreneurship", "School subjects and exam preparation",
  "Travel, transport and cities", "Space and astronomy",
  "Animals and plants", "Inventions and how things work"
];

async function suggestTopics(area, howMany) {
  const chosen = area || TOPIC_AREAS[Math.floor(Math.random() * TOPIC_AREAS.length)];
  const n = Math.min(Math.max(parseInt(howMany, 10) || 15, 3), 25);

  const existing = await sbFetch("/rest/v1/gather_topics?select=topic&order=created_at.desc&limit=150");
  const avoid = (existing || []).map(r => r.topic).join("; ").slice(0, 3500);

  const prompt = `Suggest ${n} specific topics in the area "${chosen}" for a general-knowledge assistant used by everyday people in Nigeria and beyond.
Each topic should be 3 to 10 words and specific enough to produce 5 or 6 useful questions and answers, for example "How vaccines work" rather than "Health".
Do not repeat or closely overlap these existing topics: ${avoid || "(none yet)"}
Return ONLY a JSON array of strings, no markdown.`;

  const { text, provider } = await askProviders(prompt);
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end < start) throw new Error("Could not read the topic list from the AI reply.");
  const list = JSON.parse(cleaned.slice(start, end + 1)).filter(x => typeof x === "string");

  const added = await addTopics(list, "general", false);
  return { area: chosen, provider, suggested: list.length, added: added.added };
}

// ============================================================
// What people searched for with no saved answer (table: search_demand)
// ============================================================
// Phones add anonymous key words (no name, email or account) only when the
// person allowed it and nothing saved matched. The server turns words that
// several people searched for into topics to gather.

const DEMAND_DAYS = 14;

function demandMin() { return parseInt(process.env.DEMAND_MIN, 10) || 2; }

async function readDemand() {
  const since = new Date(Date.now() - DEMAND_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbFetch(
    "/rest/v1/search_demand?select=id,words&created_at=gte." + encodeURIComponent(since) +
    "&order=created_at.desc&limit=3000"
  );
  const groups = new Map();
  for (const r of rows || []) {
    // "plants photosynthesis" and "photosynthesis plants" are the same search.
    const key = String(r.words).toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");
    if (!key) continue;
    const g = groups.get(key) || { words: r.words, count: 0, ids: [] };
    g.count++;
    g.ids.push(r.id);
    groups.set(key, g);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

async function topicsFromDemand() {
  let groups;
  try { groups = await readDemand(); } catch (e) { return { added: 0 }; }

  const wanted = groups.filter(g => g.count >= demandMin()).slice(0, 5);
  if (wanted.length) {
    const res = await addTopics(wanted.map(g => g.words), "general", false);
    const ids = wanted.flatMap(g => g.ids);
    for (let i = 0; i < ids.length; i += 100) {
      await sbFetch("/rest/v1/search_demand?id=in.(" + ids.slice(i, i + 100).join(",") + ")", { method: "DELETE" }).catch(() => {});
    }
    var added = res.added;
  }

  // Tidy: nothing is kept longer than 30 days.
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await sbFetch("/rest/v1/search_demand?created_at=lt." + encodeURIComponent(old), { method: "DELETE" }).catch(() => {});

  return { added: added || 0 };
}

// Keeps the queue from ever running dry: when fewer than 2 topics wait, topics
// people searched for come first, then the AI thinks up new ones.
async function topUpQueue() {
  const waiting = await sbCount("/rest/v1/gather_topics?select=id&status=eq.pending");
  if (waiting >= 2) return { topped: false, waiting };

  const d = await topicsFromDemand();
  if (waiting + d.added >= 2) return { topped: true, waiting, fromSearches: d.added };

  const r = await suggestTopics();
  return { topped: true, waiting, fromSearches: d.added, area: r.area, added: r.added };
}

// Small key/value settings table (admin_settings). Used for the pause switch.
async function getSetting(key) {
  try {
    const rows = await sbFetch("/rest/v1/admin_settings?select=value&key=eq." + encodeURIComponent(key));
    return rows && rows[0] ? rows[0].value : null;
  } catch (e) { return null; }
}

async function setSetting(key, value) {
  await sbFetch("/rest/v1/admin_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [{ key: key, value: String(value), updated_at: new Date().toISOString() }]
  });
}

async function autoPaused() {
  return (await getSetting("auto_gather_paused")) === "true";
}

async function knowledgeCount() {
  return sbCount("/rest/v1/knowledge?select=id");
}

async function retryFailed() {
  const rows = await sbFetch("/rest/v1/gather_topics?status=eq.failed", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { status: "pending", attempts: 0 }
  });
  return { retried: rows ? rows.length : 0 };
}

async function lastActivityAt() {
  const rows = await sbFetch("/rest/v1/gather_topics?select=done_at&done_at=not.is.null&order=done_at.desc&limit=1");
  return rows && rows[0] ? new Date(rows[0].done_at).getTime() : null;
}

// ============================================================
// Admin overview: users, knowledge, queue
// ============================================================

async function getDevices() {
  const map = new Map();
  for (let offset = 0; offset < 10000; offset += 1000) {
    const rows = await sbFetch("/rest/v1/device_sync?select=user_id,entries,last_synced_at&order=user_id.asc&limit=1000&offset=" + offset);
    (rows || []).forEach(r => map.set(r.user_id, r));
    if (!rows || rows.length < 1000) break;
  }
  return map;
}

async function getUsers() {
  const users = [];
  for (let page = 1; page <= 10; page++) {
    const d = await sbFetch("/auth/v1/admin/users?page=" + page + "&per_page=1000");
    const batch = (d && d.users) || [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }

  let devices = new Map();
  let devicesError = null;
  try { devices = await getDevices(); }
  catch (e) { devicesError = "Run setup-phase2.sql in Supabase to see what each phone holds."; }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // Only names, dates and counts leave the server. Emails and ids stay in Supabase.
  const list = users
    .map(u => {
      const d = devices.get(u.id);
      return {
        name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || null,
        joined: u.created_at,
        phoneEntries: d ? d.entries : null,
        phoneSyncedAt: d ? d.last_synced_at : null
      };
    })
    .sort((a, b) => new Date(b.joined) - new Date(a.joined));

  return {
    total: users.length,
    last7: list.filter(u => new Date(u.joined).getTime() >= weekAgo).length,
    phonesReported: list.filter(u => u.phoneEntries !== null).length,
    devicesError: devicesError,
    list: list.slice(0, 300)
  };
}

async function overview() {
  const [users, knowledge, queue, demand] = await Promise.all([
    getUsers().catch(e => ({ error: e.message })),
    sbCount("/rest/v1/knowledge?select=id").catch(() => null),
    (async () => {
      const [pending, done, failed, recent] = await Promise.all([
        sbCount("/rest/v1/gather_topics?select=id&status=eq.pending"),
        sbCount("/rest/v1/gather_topics?select=id&status=eq.done"),
        sbCount("/rest/v1/gather_topics?select=id&status=eq.failed"),
        sbFetch("/rest/v1/gather_topics?select=topic,status,added,provider,last_error&order=created_at.desc&limit=40")
      ]);
      return { pending, done, failed, recent };
    })().catch(e => ({ error: e.message })),
    readDemand().then(g => g.slice(0, 15).map(x => ({ words: x.words, count: x.count }))).catch(() => null)
  ]);
  return { users, knowledge, queue, demand, autoPaused: await autoPaused(), autoPlan: autoPlan(knowledge || 0) };
}

module.exports = {
  reply, keyMatches, envProblem, generateEntries, saveToSupabase, saveEntries, autoPlan,
  addTopics, runQueue, retryFailed, lastActivityAt, overview,
  suggestTopics, topUpQueue, knowledgeCount, autoPaused, setSetting
};
