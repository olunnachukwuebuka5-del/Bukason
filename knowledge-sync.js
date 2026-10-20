// knowledge-sync.js
// ------------------------------------------------------------
// Runs on the USER'S phone. Whenever the app is online it quietly pulls
// new or changed rows from the Supabase `knowledge` table and keeps a copy
// in IndexedDB (the browser's large storage, not the small localStorage),
// so the copy can grow to tens of thousands of entries.
//
// The offline matcher in index.html asks `candidates(tokens)` for the few
// entries that share a word with the question, so answering stays fast no
// matter how many entries are saved.
//
// Must load AFTER the script that defines SUPABASE_URL and SUPABASE_ANON_KEY
// (the anon key is safe: the table is read-only for the public).
// ------------------------------------------------------------
(function () {
  "use strict";

  var DB_NAME = "bukason-knowledge";
  var OLD_LOCAL_KEY = "bukason_server_pack"; // earlier versions kept entries here
  var DATA_SAVER_KEY = "bukason_data_saver";
  var PAGE_SIZE_WIFI = 500;
  var PAGE_SIZE_METERED = 200;
  var DAILY_BYTES_METERED = 1.5 * 1024 * 1024; // automatic download per day off Wi-Fi
  var APPROX_BYTES_PER_ENTRY = 700;
  var RESEARCH_BYTES_METERED = 400 * 1024; // related-entry downloads per day off Wi-Fi
  var RESEARCH_GAP_MS = 10 * 60 * 1000;    // the same search words are not fetched twice within this time
  var MIN_GAP_MS = 2 * 60 * 1000; // auto-sync at most every 2 minutes
  var TIMEOUT_MS = 20000;

  var byId = new Map();
  var lastSync = null;       // newest updated_at we have seen (the sync cursor)
  var lastSuccessAt = null;  // when a sync last finished OK (ISO time)
  var db = null;
  var tokenizer = null;
  var index = null;          // word -> entries that contain it
  var daily = { day: "", bytes: 0, rbytes: 0 }; // data used today (bytes: syncing, rbytes: searches)
  var lastAttempt = 0;
  var syncing = null;

  // ---------- IndexedDB helpers ----------

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("IndexedDB not available"));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains("entries")) d.createObjectStore("entries", { keyPath: "id" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // Save a batch of rows and the cursor in ONE transaction, so a sync that
  // is interrupted halfway resumes cleanly from the last saved page.
  function saveBatch(rows, meta) {
    if (!db) return Promise.resolve(); // memory-only this session
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(["entries", "meta"], "readwrite");
      var entries = tx.objectStore("entries");
      var metaStore = tx.objectStore("meta");
      rows.forEach(function (r) { entries.put(r); });
      Object.keys(meta).forEach(function (k) { metaStore.put(meta[k], k); });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("save aborted")); };
    });
  }

  async function loadAll() {
    try {
      db = await openDb();
      var tx = db.transaction(["entries", "meta"], "readonly");
      var all = await wrap(tx.objectStore("entries").getAll());
      lastSync = (await wrap(tx.objectStore("meta").get("lastSync"))) || null;
      lastSuccessAt = (await wrap(tx.objectStore("meta").get("lastSuccessAt"))) || null;
      daily = (await wrap(tx.objectStore("meta").get("daily"))) || daily;
      all.forEach(function (e) { byId.set(e.id, e); });
    } catch (err) {
      db = null;
      console.warn("BUKASON: could not open saved knowledge; using memory only this session.", err);
    }
    await migrateOldStorage();
  }

  // Earlier versions saved entries in localStorage. Move them over once.
  async function migrateOldStorage() {
    try {
      var raw = localStorage.getItem(OLD_LOCAL_KEY);
      if (!raw) return;
      var old = JSON.parse(raw);
      var rows = (old && Array.isArray(old.entries)) ? old.entries.filter(function (e) { return e && e.id && !byId.has(e.id); }) : [];
      rows.forEach(function (e) { byId.set(e.id, e); });
      if (old && old.lastSync && (!lastSync || old.lastSync > lastSync)) lastSync = old.lastSync;
      await saveBatch(rows, { lastSync: lastSync });
      localStorage.removeItem(OLD_LOCAL_KEY); // frees the small localStorage space
    } catch (err) {
      console.warn("BUKASON: could not move old saved knowledge.", err);
    }
  }

  var ready = loadAll().catch(function () {});

  // ---------- search index ----------

  function entryText(e) {
    return (e.question || "") + " " + (e.keywords || []).join(" ");
  }

  function indexAdd(e) {
    if (!index || !tokenizer) return;
    var seen = new Set(tokenizer(entryText(e)));
    seen.forEach(function (t) {
      var list = index.get(t);
      if (!list) { list = []; index.set(t, list); }
      list.push(e);
    });
  }

  function ensureIndex() {
    if (index || !tokenizer) return;
    index = new Map();
    byId.forEach(indexAdd);
  }

  // ---------- helpers ----------

  function dataSaverOn() {
    try { return localStorage.getItem(DATA_SAVER_KEY) === "1"; }
    catch (e) { return false; }
  }

  // Unless we are sure the phone is on Wi-Fi or a cable, treat the connection
  // as mobile data and keep automatic downloads small.
  function isMetered() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return true;
    if (c.saveData) return true;
    return !(c.type === "wifi" || c.type === "ethernet");
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function usedToday() { return daily.day === today() ? daily.bytes : 0; }
  function researchUsedToday() { return daily.day === today() ? (daily.rbytes || 0) : 0; }

  function rollDay() {
    var t = today();
    if (daily.day !== t) daily = { day: t, bytes: 0, rbytes: 0 };
  }
  function addBytes(n) { rollDay(); daily.bytes += n; }
  function addResearchBytes(n) { rollDay(); daily.rbytes = (daily.rbytes || 0) + n; }

  function toEntry(row) {
    return {
      id: row.id, mode: row.mode, question: row.question,
      keywords: row.keywords || [], answer: row.answer, updated_at: row.updated_at
    };
  }

  // Put rows in memory and the search index. Returns how many were new or changed.
  function mergeRows(clean) {
    var changed = 0;
    clean.forEach(function (e) {
      var before = byId.get(e.id);
      if (!before || before.updated_at !== e.updated_at) changed++;
      byId.set(e.id, e);
      if (before) index = null;   // an edited answer: rebuild the index lazily
      else indexAdd(e);
    });
    return changed;
  }

  function configReady() {
    return typeof SUPABASE_URL !== "undefined" && typeof SUPABASE_ANON_KEY !== "undefined";
  }

  function fetchWithTimeout(url, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    options.signal = controller.signal;
    return fetch(url, options).finally(function () { clearTimeout(timer); });
  }

  // ---------- the sync itself ----------

  async function run(force) {
    await ready;
    var cursor = lastSync;
    var changed = 0;
    var partial = false;
    var limited = !force && isMetered();          // mobile data: small daily amount
    var pageSize = limited ? PAGE_SIZE_METERED : PAGE_SIZE_WIFI;

    while (true) {
      if (limited && usedToday() >= DAILY_BYTES_METERED) { partial = true; break; }

      var url = SUPABASE_URL + "/rest/v1/knowledge" +
        "?select=id,mode,question,keywords,answer,updated_at" +
        "&order=updated_at.asc&limit=" + pageSize;
      // gte (not gt) so rows sharing a timestamp across a page edge are never
      // skipped. Saving by id makes re-reading them harmless.
      if (cursor) url += "&updated_at=gte." + encodeURIComponent(cursor);

      var res = await fetchWithTimeout(url, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }
      });
      if (!res.ok) throw new Error("Sync failed (status " + res.status + ")");

      var bodyText = await res.text();
      if (limited) addBytes(bodyText.length);
      var rows = JSON.parse(bodyText);
      if (!Array.isArray(rows)) throw new Error("Unexpected sync reply.");
      if (!rows.length) break;

      var clean = rows.map(toEntry);
      changed += mergeRows(clean);

      var newCursor = clean[clean.length - 1].updated_at;
      var stuck = newCursor === cursor;
      cursor = newCursor;
      lastSync = cursor;
      await saveBatch(clean, { lastSync: cursor, daily: daily });   // progress saved page by page

      if (rows.length < pageSize || stuck) break;
    }

    lastSuccessAt = new Date().toISOString();
    await saveBatch([], { lastSync: lastSync, lastSuccessAt: lastSuccessAt, daily: daily }).catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    return { changed: changed, total: byId.size, partial: partial };
  }

  function sync(force) {
    if (syncing) return syncing;
    if (!configReady()) return Promise.resolve({ skipped: "not-configured" });
    if (!navigator.onLine) return Promise.resolve({ skipped: "offline" });
    if (!force && dataSaverOn()) return Promise.resolve({ skipped: "data-saver" });
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return Promise.resolve({ skipped: "recent" });

    lastAttempt = Date.now();
    syncing = run(!!force)
      .then(function (result) {
        window.dispatchEvent(new CustomEvent("bukason-knowledge-synced", { detail: result }));
        return result;
      })
      .catch(function (err) {
        console.warn("BUKASON knowledge sync:", err);
        return { error: err.message || "Sync failed" };
      })
      .finally(function () { syncing = null; });
    return syncing;
  }

  // How much is still waiting on the server for this phone.
  async function pending() {
    await ready;
    if (!configReady() || !navigator.onLine) return null;
    try {
      var url = SUPABASE_URL + "/rest/v1/knowledge?select=id";
      if (lastSync) url += "&updated_at=gt." + encodeURIComponent(lastSync);
      var res = await fetchWithTimeout(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY,
          Prefer: "count=exact", Range: "0-0"
        }
      });
      if (!res.ok) return null;
      var total = (res.headers.get("content-range") || "").split("/")[1];
      var count = total && total !== "*" ? parseInt(total, 10) : 0;
      return { count: count, approxMB: (count * APPROX_BYTES_PER_ENTRY) / (1024 * 1024) };
    } catch (e) { return null; }
  }

  // ---------- search-triggered download ("research") ----------
  // When someone searches, the phone also pulls the saved entries related to
  // those words, then entries related to the words those results use. So the
  // phone's copy grows toward whatever the person is exploring.

  var researching = false;
  var recentResearch = {};

  function splitWords(text) {
    var all = tokenizer ? tokenizer(text) : String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
    return all.filter(function (w) { return /^[a-z0-9]{3,30}$/.test(w); });
  }

  function rank(rows, words) {
    var scored = rows.map(function (e) {
      var have = new Set(splitWords(entryText(e)));
      var hits = 0;
      words.forEach(function (w) { if (have.has(w)) hits++; });
      return { e: e, hits: hits };
    });
    scored.sort(function (a, b) { return b.hits - a.hits; });
    return scored.map(function (x) { return x.e; });
  }

  // Words the best results are tagged with, excluding what was searched.
  function relatedWords(rows, exclude) {
    var skip = new Set(exclude);
    var counts = {};
    rows.slice(0, 3).forEach(function (e) {
      splitWords((e.keywords || []).join(" ")).forEach(function (w) {
        if (!skip.has(w)) counts[w] = (counts[w] || 0) + 1;
      });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 5);
  }

  // Entries this phone already holds for these words. They are left out of
  // the request, so every search brings NEW related entries, not repeats.
  function heldIds(words) {
    if (!tokenizer) return [];
    ensureIndex();
    var ids = [];
    var seenIds = {};
    words.forEach(function (w) {
      (index.get(w) || []).forEach(function (e) {
        if (!seenIds[e.id] && ids.length < 60) { seenIds[e.id] = true; ids.push(e.id); }
      });
    });
    return ids;
  }

  async function fetchRelated(words, limit) {
    var held = heldIds(words).filter(function (id) { return /^[A-Za-z0-9-]{8,64}$/.test(id); });
    var url = SUPABASE_URL + "/rest/v1/knowledge" +
      "?select=id,mode,question,keywords,answer,updated_at" +
      "&search_vec=" + encodeURIComponent("fts(english)." + words.join("|")) +
      (held.length ? "&id=" + encodeURIComponent("not.in.(" + held.join(",") + ")") : "") +
      "&limit=" + limit;
    var res = await fetchWithTimeout(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }
    });
    if (!res.ok) throw new Error("Related search failed (status " + res.status + ")");
    var text = await res.text();
    addResearchBytes(text.length);
    var rows = JSON.parse(text);
    return Array.isArray(rows) ? rows.map(toEntry) : [];
  }

  function overResearchBudget() {
    return isMetered() && researchUsedToday() >= RESEARCH_BYTES_METERED;
  }

  async function research(tokens) {
    try {
      await ready;
      if (researching) return { skipped: "busy" };
      if (!configReady() || !navigator.onLine || dataSaverOn()) return { skipped: "unavailable" };

      var seen = {};
      var words = (tokens || []).filter(function (w) {
        if (!/^[a-z0-9]{3,30}$/.test(w) || seen[w]) return false;
        seen[w] = true; return true;
      }).slice(0, 6);
      if (!words.length) return { skipped: "no-words" };

      var key = words.slice().sort().join(" ");
      if (recentResearch[key] && Date.now() - recentResearch[key] < RESEARCH_GAP_MS) return { skipped: "recent" };
      if (overResearchBudget()) return { skipped: "budget" };

      researching = true;
      recentResearch[key] = Date.now();

      var first = rank(await fetchRelated(words, 40), words).slice(0, 25);
      var added = mergeRows(first);

      var second = [];
      var more = relatedWords(first, words);
      if (more.length && !overResearchBudget()) {
        second = rank(await fetchRelated(more, 30), more).slice(0, 15);
        added += mergeRows(second);
      }

      await saveBatch(first.concat(second), { daily: daily }); // the sync cursor is not touched
      var result = { added: added, total: byId.size };
      window.dispatchEvent(new CustomEvent("bukason-knowledge-researched", { detail: result }));
      return result;
    } catch (err) {
      console.warn("BUKASON related search:", err);
      return { error: err.message || "Related search failed" };
    } finally {
      researching = false;
    }
  }

  // ---------- public API ----------

  window.BukasonKnowledge = {
    ready: ready,
    sync: sync,
    count: function () { return byId.size; },
    lastSyncedAt: function () { return lastSync; },
    lastSuccessAt: function () { return lastSuccessAt; },
    getEntries: function () { return Array.from(byId.values()); },
    isMetered: isMetered,
    research: research,
    pending: pending,

    // The page tells us how to split text into words, so the index and the
    // scorer always agree.
    setTokenizer: function (fn) { tokenizer = fn; index = null; },

    // Entries that share at least one word with the question.
    candidates: function (queryTokens) {
      if (!tokenizer) return Array.from(byId.values());
      ensureIndex();
      var seen = new Set();
      var out = [];
      for (var i = 0; i < queryTokens.length; i++) {
        var list = index.get(queryTokens[i]);
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          if (!seen.has(list[j])) { seen.add(list[j]); out.push(list[j]); }
        }
      }
      return out;
    },

    reset: async function () {
      byId.clear(); lastSync = null; lastSuccessAt = null; index = null;
      try { localStorage.removeItem(OLD_LOCAL_KEY); } catch (e) {}
      if (db) {
        await new Promise(function (resolve) {
          var tx = db.transaction(["entries", "meta"], "readwrite");
          tx.objectStore("entries").clear();
          tx.objectStore("meta").clear();
          tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
        });
      }
    }
  };

  // ---------- automatic triggers ----------

  setTimeout(function () { sync(false); }, 1500);
  window.addEventListener("online", function () { sync(false); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") sync(false);
  });
})();
