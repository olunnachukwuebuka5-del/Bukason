// ============================================================
// BUKASON — Offline AI module
//
// Loads a small language model that runs entirely inside the
// browser (via WebLLM + WebGPU), so BUKASON can keep answering
// even with zero internet connection. app.js calls into this
// through window.BukasonOfflineAI — this file is a classic
// <script type="module">, so it self-registers that global.
//
// Requirements this depends on:
// - Browser/device supports WebGPU (checked before doing anything)
// - The model must be downloaded once WHILE ONLINE before it can
//   be used offline (this file starts that download on page load)
// - netlify.toml's CSP must allow the domains this fetches from
//   (see the accompanying netlify.toml patch)
// ============================================================

const PREFERRED_MODEL_SUBSTRINGS = [
  "SmolLM2-360M-Instruct",   // smallest — try first
  "Qwen2.5-0.5B-Instruct",
  "Llama-3.2-1B-Instruct",
];

const QUEUE_KEY = "bukason_offline_queue";

let engine = null;
let ready = false;
let failed = false;
let modelId = null;

// ---- Minimal status banner, injected so no index.html/CSS edits are required ----
const banner = document.createElement("div");
banner.id = "offlineAiBanner";
banner.style.cssText = `
  position:fixed; left:0; right:0; bottom:0; z-index:250;
  font-family:Inter,sans-serif; font-size:12px; line-height:1.4;
  color:#B9C4DA; background:#0A1830; border-top:1px solid rgba(255,255,255,0.08);
  padding:7px 14px; display:none;
`;
function mountBanner() {
  if (document.body) document.body.appendChild(banner);
  else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(banner));
}
mountBanner();

function showBanner(text, color) {
  banner.style.display = "block";
  banner.style.color = color || "#B9C4DA";
  banner.textContent = text;
}
function hideBanner() {
  banner.style.display = "none";
}
function flashBanner(text, color, ms = 4000) {
  showBanner(text, color);
  setTimeout(hideBanner, ms);
}

// ---- Loading the model ----
async function init() {
  if (!("gpu" in navigator)) {
    failed = true;
    flashBanner("Offline AI isn't supported on this browser — offline messages will be queued instead.", "#E8CD74", 6000);
    return;
  }

  try {
    const webllm = await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm");

    const available = webllm.prebuiltAppConfig.model_list.map((m) => m.model_id);
    modelId = PREFERRED_MODEL_SUBSTRINGS
      .map((needle) => available.find((id) => id.includes(needle)))
      .find(Boolean);

    if (!modelId) throw new Error("No suitable small model found in this WebLLM version.");

    showBanner("Preparing offline AI…");

    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        const pct = Math.round((report.progress || 0) * 100);
        showBanner(`Downloading offline AI: ${pct}% (one-time, then works with no internet)`);
      },
    });

    ready = true;
    flashBanner("Offline AI ready ✓ — BUKASON will keep working with no internet.", "#7CD992", 3500);
  } catch (err) {
    failed = true;
    flashBanner("Couldn't load offline AI on this device — offline messages will be queued instead.", "#E8CD74", 6000);
    console.error("BUKASON offline AI setup failed:", err);
  }
}

// ---- Generating a reply locally ----
async function reply(systemPrompt, history) {
  if (!ready) throw new Error("Offline engine not ready");

  const messages = [
    {
      role: "system",
      content:
        (systemPrompt || "") +
        " You are currently running fully offline on the user's device using a small local model. Keep answers short and simple.",
    },
    // Only recent turns — small models have small context windows.
    ...history.slice(-8).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  const completion = await engine.chat.completions.create({
    messages,
    temperature: 0.7,
    max_tokens: 300,
  });

  return completion.choices[0].message.content;
}

function isReady() {
  return ready;
}
function hasFailed() {
  return failed;
}
function currentModelId() {
  return modelId;
}

// ---- Queue for messages that couldn't be answered at all (offline + model not ready/unsupported) ----
function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function saveQueueRaw(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}
function enqueue(mode, content) {
  const q = getQueue();
  q.push({ mode, content, ts: Date.now() });
  saveQueueRaw(q);
}
function drainQueue() {
  const q = getQueue();
  saveQueueRaw([]);
  return q;
}
function queueLength() {
  return getQueue().length;
}

window.BukasonOfflineAI = {
  init,
  reply,
  isReady,
  hasFailed,
  currentModelId,
  enqueue,
  drainQueue,
  queueLength,
  showBanner,
  hideBanner,
  flashBanner,
};

init(); // start downloading/caching immediately, while we're online
