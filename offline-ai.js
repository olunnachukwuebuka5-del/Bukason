// ============================================================
// BUKASON — Offline Knowledge module
//
// Lightweight offline answering, NOT a downloaded AI model:
// - While online, the app quietly fetches a small JSON file
//   (offline-knowledge.json) — a few hundred KB of plain text
//   Q&A, not a model. Costs about as much data as one webpage.
// - That file gets cached on the device (localStorage).
// - When offline, the app searches the cached pack with simple
//   keyword matching and answers instantly from it if there's a
//   good match. If there isn't, it says so honestly and queues
//   the question for when the user is back online.
// - Works on every phone/browser — no WebGPU, no big download,
//   no GPU requirement.
//
// Growing the pack: offline-knowledge.json is a normal file you
// edit (add more {question, keywords, answer, mode} entries) and
// re-upload like any other site file. Each time the app goes
// online it re-fetches the latest version automatically.
// ============================================================

const PACK_URL = "offline-knowledge.json";
const STORAGE_KEY = "bukason_offline_knowledge";
const QUEUE_KEY = "bukason_offline_queue";
const MATCH_THRESHOLD = 0.4; // fraction of the question's words that must match an entry

let pack = null;
let loaded = false;
let loadFailed = false;

// ---- Minimal status banner ----
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
function showBanner(text, color) { banner.style.display = "block"; banner.style.color = color || "#B9C4DA"; banner.textContent = text; }
function hideBanner() { banner.style.display = "none"; }
function flashBanner(text, color, ms = 4000) { showBanner(text, color); setTimeout(hideBanner, ms); }

// ---- Loading the knowledge pack ----
async function init() {
  // 1) Use whatever was cached from a previous online visit, immediately —
  //    this is what makes offline mode work even with no connection at all.
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.entries)) { pack = parsed; loaded = true; }
    }
  } catch (e) { /* ignore corrupt cache, fall through to fetch */ }

  // 2) If online right now, fetch the latest pack in the background and
  //    refresh the cache. Small file — negligible data cost.
  if (navigator.onLine) {
    try {
      const res = await fetch(PACK_URL, { cache: "no-store" });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && Array.isArray(fresh.entries)) {
          pack = fresh;
          loaded = true;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        }
      }
    } catch (err) {
      console.error("BUKASON offline knowledge pack refresh failed:", err);
      // Not fatal — whatever was already cached (if anything) still works.
    }
  }

  if (!loaded) {
    loadFailed = true;
    flashBanner("Offline answers aren't saved on this device yet — stay connected for a moment to enable them.", "#E8CD74", 7000);
  }
}

function isReady() { return loaded && !!pack; }
function hasFailed() { return loadFailed; }

// ---- Simple keyword matching (no AI, just word overlap) ----
function tokenize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreEntry(queryTokens, entry) {
  const entryTokens = new Set([
    ...tokenize(entry.question),
    ...tokenize((entry.keywords || []).join(" ")),
  ]);
  if (entryTokens.size === 0 || queryTokens.length === 0) return 0;
  let hits = 0;
  queryTokens.forEach((t) => { if (entryTokens.has(t)) hits++; });
  return hits / queryTokens.length;
}

function findBestMatch(query, mode) {
  if (!pack || !Array.isArray(pack.entries)) return null;
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return null;

  let best = null;
  let bestScore = 0;
  pack.entries.forEach((entry) => {
    if (entry.mode && mode && entry.mode !== mode && entry.mode !== "general") return;
    const score = scoreEntry(queryTokens, entry);
    if (score > bestScore) { bestScore = score; best = entry; }
  });

  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// ---- Public reply() — same shape app.js already expects ----
async function reply(systemPrompt, history, mode) {
  if (!isReady()) throw new Error("OFFLINE_KNOWLEDGE_NOT_READY");
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const query = lastUserMsg ? lastUserMsg.content : "";
  const match = findBestMatch(query, mode);
  if (!match) throw new Error("NO_OFFLINE_MATCH");
  return match.answer;
}

// ---- Queue for messages with no offline answer available (unchanged behavior) ----
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
}
function saveQueueRaw(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(mode, content) { const q = getQueue(); q.push({ mode, content, ts: Date.now() }); saveQueueRaw(q); }
function drainQueue() { const q = getQueue(); saveQueueRaw([]); return q; }
function queueLength() { return getQueue().length; }

window.BukasonOfflineAI = {
  init,
  reply,
  isReady,
  hasFailed,
  enqueue,
  drainQueue,
  queueLength,
  showBanner,
  hideBanner,
  flashBanner,
};

init();
