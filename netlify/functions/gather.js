// netlify/functions/gather.js
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

function buildPrompt(topic, count) {
  return `You are building an offline knowledge pack for BUKASON, an assistant for Nigerian students.
Topic: "${topic}"

Write ${count} distinct question-and-answer entries a student might ask about this topic.
Rules:
- Answers must be accurate, clear and self-contained, 2 to 5 sentences each, plain text only.
- Do not invent facts, dates, prices or statistics. If unsure, leave that entry out.
- "keywords" are 3 to 8 lowercase words or short phrases a student might type when asking.
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
  const prompt = buildPrompt(topic, count);
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Use POST." });
  }

  const missing = ["ADMIN_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
    .filter(name => !process.env[name]);
  if (missing.length) {
    return reply(500, { error: `Missing Netlify environment variables: ${missing.join(", ")}` });
  }
  const aiKeys = ["GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY"];
  if (!aiKeys.some(name => process.env[name])) {
    return reply(500, { error: "No AI key found. Add at least one of: " + aiKeys.join(", ") });
  }

  if (!keyMatches(event.headers["x-admin-key"], process.env.ADMIN_KEY)) {
    return reply(401, { error: "Wrong admin key." });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Request body was not valid JSON." });
  }

  const topic = String(input.topic || "").trim().slice(0, 200);
  if (topic.length < 3) {
    return reply(400, { error: "Type a topic (at least 3 characters)." });
  }

  const count = Math.min(Math.max(parseInt(input.count, 10) || 8, 1), 15);
  const mode = ["academics", "business", "general"].includes(input.mode) ? input.mode : "general";
  const useWeb = input.useWeb === true;

  try {
    const { entries, provider, webUsed, failures } = await generateEntries(topic, count, mode, useWeb);

    const saved = await saveToSupabase(entries);
    return reply(200, {
      topic,
      provider,
      webRequested: useWeb,
      webUsed,
      requested: count,
      usable: entries.length,
      added: saved.length,
      skippedDuplicates: entries.length - saved.length,
      earlierFailures: failures,
      questions: saved.map(r => r.question)
    });
  } catch (err) {
    return reply(502, { error: err.message || "Something went wrong." });
  }
};
