// knowledge-sync.js
// ------------------------------------------------------------
// Runs on the USER'S phone. Whenever the app is online, it quietly
// pulls new or changed rows from the Supabase `knowledge` table and
// keeps a copy in localStorage. The offline matcher in index.html
// then answers from that copy with no connection at all.
//
// Must load AFTER the script that defines SUPABASE_URL and
// SUPABASE_ANON_KEY (the anon key is safe: the table is read-only
// for the public, see setup-knowledge.sql).
// ------------------------------------------------------------
(function () {
  "use strict";

  var STORE_KEY = "bukason_server_pack";
  var DATA_SAVER_KEY = "bukason_data_saver";
  var PAGE_SIZE = 500;
  var MIN_GAP_MS = 10 * 60 * 1000; // auto-sync at most every 10 minutes
  var TIMEOUT_MS = 15000;

  var byId = new Map();
  var lastSync = null;
  var lastAttempt = 0;
  var syncing = null;
  var cache = null; // array copy for fast matching

  // ---------- storage ----------

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved && Array.isArray(saved.entries)) {
        saved.entries.forEach(function (e) { if (e && e.id) byId.set(e.id, e); });
        lastSync = saved.lastSync || null;
      }
    } catch (err) {
      console.warn("BUKASON: saved knowledge was unreadable, starting fresh.", err);
    }
  }

  function persist() {
    cache = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        lastSync: lastSync,
        entries: Array.from(byId.values())
      }));
    } catch (err) {
      // Storage full: keep working from memory this session.
      console.warn("BUKASON: could not save knowledge (storage full?).", err);
    }
  }

  // ---------- helpers ----------

  function dataSaverOn() {
    try { return localStorage.getItem(DATA_SAVER_KEY) === "1"; }
    catch (e) { return false; }
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

  async function run() {
    var cursor = lastSync;
    var changed = 0;

    while (true) {
      var url = SUPABASE_URL + "/rest/v1/knowledge" +
        "?select=id,mode,question,keywords,answer,updated_at" +
        "&order=updated_at.asc&limit=" + PAGE_SIZE;
      // gte (not gt) so rows sharing a timestamp across a page edge are
      // never skipped. Merging by id makes re-reading them harmless.
      if (cursor) url += "&updated_at=gte." + encodeURIComponent(cursor);

      var res = await fetchWithTimeout(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: "Bearer " + SUPABASE_ANON_KEY
        }
      });
      if (!res.ok) throw new Error("Sync failed (status " + res.status + ")");

      var rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("Unexpected sync reply.");

      rows.forEach(function (row) {
        var before = byId.get(row.id);
        if (!before || before.updated_at !== row.updated_at) changed++;
        byId.set(row.id, {
          id: row.id,
          mode: row.mode,
          question: row.question,
          keywords: row.keywords || [],
          answer: row.answer,
          updated_at: row.updated_at
        });
      });

      if (!rows.length) break;
      var newCursor = rows[rows.length - 1].updated_at;
      var stuck = newCursor === cursor;
      cursor = newCursor;
      if (rows.length < PAGE_SIZE || stuck) break;
    }

    lastSync = cursor;
    persist();
    return { changed: changed, total: byId.size };
  }

  function sync(force) {
    if (syncing) return syncing;
    if (!configReady()) return Promise.resolve({ skipped: "not-configured" });
    if (!navigator.onLine) return Promise.resolve({ skipped: "offline" });
    if (!force && dataSaverOn()) return Promise.resolve({ skipped: "data-saver" });
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return Promise.resolve({ skipped: "recent" });

    lastAttempt = Date.now();
    syncing = run()
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

  // ---------- public API ----------

  window.BukasonKnowledge = {
    sync: sync,
    getEntries: function () {
      if (!cache) cache = Array.from(byId.values());
      return cache;
    },
    count: function () { return byId.size; },
    lastSyncedAt: function () { return lastSync; },
    reset: function () {
      byId.clear();
      lastSync = null;
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      cache = null;
    }
  };

  // ---------- automatic triggers ----------

  load();
  setTimeout(function () { sync(false); }, 1500);
  window.addEventListener("online", function () { sync(false); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") sync(false);
  });
})();
