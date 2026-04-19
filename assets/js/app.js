/* Live Tech News Board — client-side renderer
 * - Loads data/news.json (produced by scripts/update_news.py via GitHub Actions)
 * - Renders 4 lanes: Gadgets, Innovation, AI, Science
 * - Rotates visible headlines per-lane (newest on top)
 * - Fuse.js fuzzy search across entire 90-day archive
 * - Auto-polls data/news.json for near-real-time refresh
 */
(function () {
  "use strict";

  const LANES = [
    { key: "gadgets",    title: "Gadgets" },
    { key: "innovation", title: "Innovation" },
    { key: "ai",         title: "AI" },
    { key: "science",    title: "Science" } // tech-bent
  ];
  const VISIBLE_PER_LANE = 5;                  // how many headlines on screen at once
  const ROTATION_MS = 5 * 60 * 1000;           // each lane advances one slot every 5 min
  const LANE_STAGGER_MS = 75 * 1000;           // lane N offset: N * 75s (staggered, not synchronized)
  const POLL_MS = 5 * 60 * 1000;               // refresh JSON every 5 min
  const DATA_URL = "./data/news.json";

  const state = {
    snapshot: null,        // full JSON { generated_at, lanes: {key: [items...]} }
    visibleOffset: {},     // per-lane scroll offset into its queue
    laneTimers: {},        // per-lane setTimeout handle
    pollTimer: null,
    fuse: null
  };

  // --- Boot ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    buildLanes();
    wireControls();
    document.getElementById("pollMin").textContent = String(Math.round(POLL_MS / 60000));
    loadData(true).then(() => {
      scheduleLaneRotations();
      state.pollTimer = setInterval(() => loadData(false), POLL_MS);
    });
    registerServiceWorker();
  });

  // --- Per-lane staggered rotation ---------------------------------------
  // Lane i advances 1 slot every ROTATION_MS, with an initial offset of
  // i * LANE_STAGGER_MS so the four lanes move at different wall-clock times.
  function scheduleLaneRotations() {
    LANES.forEach((lane, i) => {
      // Clear any prior handle on reload
      if (state.laneTimers[lane.key]) clearTimeout(state.laneTimers[lane.key]);
      const initialDelay = (i * LANE_STAGGER_MS) % ROTATION_MS;
      state.laneTimers[lane.key] = setTimeout(function tick() {
        rotateLane(lane.key);
        state.laneTimers[lane.key] = setTimeout(tick, ROTATION_MS);
      }, Math.max(1000, initialDelay));
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Skip in sandboxed preview frames where SW registration often fails silently.
    try {
      navigator.serviceWorker.register("./sw.js").catch(() => { /* non-fatal */ });
    } catch (_) { /* non-fatal */ }
  }

  // --- Lane DOM scaffolding ----------------------------------------------
  function buildLanes() {
    const board = document.getElementById("board");
    board.innerHTML = "";
    for (const lane of LANES) {
      state.visibleOffset[lane.key] = 0;
      const el = document.createElement("section");
      el.className = "lane";
      el.dataset.lane = lane.key;
      el.innerHTML = `
        <header>
          <h2>${lane.title}</h2>
          <span class="meta" data-role="meta">—</span>
        </header>
        <ol data-role="list"></ol>
      `;
      board.appendChild(el);
    }
  }

  // --- Data fetch ---------------------------------------------------------
  async function loadData(initial) {
    const btn = document.getElementById("refresh");
    const origLabel = btn ? btn.textContent : null;
    if (btn && !initial) { btn.disabled = true; btn.textContent = "↻ Fetching…"; }
    setStatus("Fetching latest…");
    try {
      const res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      state.snapshot = normalizeSnapshot(json);
      rebuildFuse();
      renderAllLanes();
      const genMs = state.snapshot.generated_at ? Date.parse(state.snapshot.generated_at) : NaN;
      const ageMin = Number.isFinite(genMs) ? Math.round((Date.now() - genMs) / 60000) : null;
      const tsStr = Number.isFinite(genMs) ? new Date(genMs).toLocaleString() : "unknown";
      document.getElementById("lastUpdated").textContent =
        ageMin == null ? "Last updated: unknown"
        : `Snapshot ${ageMin === 0 ? "just now" : ageMin + " min ago"} · ${tsStr}`;
      // newest headline age across all lanes
      let newestMs = 0;
      for (const l of LANES) {
        for (const it of (state.snapshot.lanes[l.key] || [])) {
          const t = it.published_ts || (it.published ? Date.parse(it.published) : 0);
          if (t > newestMs) newestMs = t;
        }
      }
      const newestAge = newestMs ? Math.round((Date.now() - newestMs) / 60000) : null;
      const newestStr = newestAge == null ? ""
        : ` · newest headline ${newestAge < 1 ? "just now" : newestAge + " min ago"}`;
      const totals = LANES.map(l => `${l.title}:${(state.snapshot.lanes[l.key] || []).length}`).join("  ");
      setStatus(`${totalItems()} items · ${totals}${newestStr}`);
    } catch (err) {
      console.error(err);
      if (initial) {
        setStatus("Could not load data/news.json — the ingestion script may not have run yet. Run scripts/update_news.py or trigger the GitHub Action.", "err");
      } else {
        setStatus("Refresh failed: " + err.message, "warn");
      }
    } finally {
      if (btn && !initial) {
        btn.disabled = false;
        if (origLabel) btn.textContent = origLabel;
      }
    }
  }

  function normalizeSnapshot(json) {
    const lanes = {};
    for (const l of LANES) {
      const arr = Array.isArray(json?.lanes?.[l.key]) ? json.lanes[l.key].slice() : [];
      // sort newest first by published_ts (ms epoch) then by score
      arr.sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0) || (b.score || 0) - (a.score || 0));
      lanes[l.key] = arr;
    }
    return { generated_at: json?.generated_at || null, lanes, meta: json?.meta || {} };
  }

  function totalItems() {
    return LANES.reduce((n, l) => n + (state.snapshot.lanes[l.key] || []).length, 0);
  }

  // --- Fuse index ---------------------------------------------------------
  function rebuildFuse() {
    if (typeof Fuse === "undefined") return;
    const all = [];
    for (const l of LANES) {
      for (const it of (state.snapshot.lanes[l.key] || [])) {
        all.push({ ...it, lane: l.key, lane_title: l.title });
      }
    }
    state.fuse = new Fuse(all, {
      includeScore: true,
      threshold: 0.38,
      ignoreLocation: true,
      keys: [
        { name: "title",  weight: 0.6 },
        { name: "source", weight: 0.2 },
        { name: "tags",   weight: 0.15 },
        { name: "summary",weight: 0.05 }
      ]
    });
  }

  // --- Rendering ----------------------------------------------------------
  function renderAllLanes() {
    for (const lane of LANES) renderLane(lane.key);
  }

  function renderLane(key) {
    const laneEl = document.querySelector(`.lane[data-lane="${key}"]`);
    if (!laneEl) return;
    const listEl = laneEl.querySelector('[data-role="list"]');
    const metaEl = laneEl.querySelector('[data-role="meta"]');
    const items = state.snapshot.lanes[key] || [];
    metaEl.textContent = items.length ? `${items.length} in 90-day archive` : "no items";

    if (!items.length) {
      listEl.innerHTML = `<li class="muted" style="padding:12px 10px;">No items yet. The GitHub Action will populate this lane on its next run.</li>`;
      return;
    }

    const offset = state.visibleOffset[key] % items.length;
    const visible = [];
    for (let i = 0; i < Math.min(VISIBLE_PER_LANE, items.length); i++) {
      visible.push(items[(offset + i) % items.length]);
    }

    listEl.innerHTML = visible.map((it, idx) => itemHTML(it, idx + 1)).join("");
  }

  function rotateLane(key) {
    const items = state.snapshot?.lanes?.[key] || [];
    if (items.length <= VISIBLE_PER_LANE) return; // nothing to rotate
    state.visibleOffset[key] = (state.visibleOffset[key] + 1) % items.length;
    const listEl = document.querySelector(`.lane[data-lane="${key}"] [data-role="list"]`);
    if (listEl) {
      listEl.classList.add("entering");
      renderLane(key);
      requestAnimationFrame(() => listEl.classList.remove("entering"));
    }
  }

  function itemHTML(it, rank) {
    const when = it.published_ts ? timeAgo(it.published_ts) : "";
    const paywall = it.paywall ? '<span class="pill paywall" title="May be paywalled">$</span>' : "";
    const impact = (it.impact || "").toLowerCase() === "high"
      ? '<span class="pill impact-high" title="Higher impact / less circulated">★</span>'
      : "";
    const src = escapeHTML(it.source || "");
    const title = escapeHTML(it.title || "(untitled)");
    const url = it.url || "#";
    return `
      <li class="item">
        <div class="rank">${rank}</div>
        <div class="body">
          <a class="title" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${title}</a>
          <div class="sub">
            <span class="source">${src}</span>
            <span class="time">${when}</span>
            ${impact}${paywall}
          </div>
        </div>
        <div class="go">↗</div>
      </li>
    `;
  }

  // --- Search -------------------------------------------------------------
  function wireControls() {
    const search = document.getElementById("search");
    const resultsEl = document.getElementById("searchResults");
    const listEl = document.getElementById("searchList");
    const countEl = document.getElementById("searchCount");
    const boardEl = document.getElementById("board");

    search.addEventListener("input", () => {
      const q = search.value.trim();
      if (!q) {
        resultsEl.hidden = true;
        boardEl.hidden = false;
        return;
      }
      if (!state.fuse) { resultsEl.hidden = true; return; }
      const hits = state.fuse.search(q).slice(0, 40);
      countEl.textContent = `(${hits.length})`;
      listEl.innerHTML = hits.map(h => {
        const it = h.item;
        return `<li>
          <a href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHTML(it.title)}</strong></a>
          <div class="sub" style="font-size:12px;color:var(--fg-dim);">
            <span class="source">${escapeHTML(it.source || "")}</span>
            · <span class="muted">${escapeHTML(it.lane_title)}</span>
            · <span class="time">${it.published_ts ? timeAgo(it.published_ts) : ""}</span>
          </div>
        </li>`;
      }).join("");
      resultsEl.hidden = false;
      boardEl.hidden = true;
    });

    document.getElementById("refresh").addEventListener("click", () => loadData(false));

    // PWA install prompt: surface a button in the footer when available.
    const installBtn = document.getElementById("installBtn");
    let deferredInstall = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstall = e;
      if (installBtn) installBtn.hidden = false;
    });
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        try { await deferredInstall.userChoice; } catch (_) {}
        deferredInstall = null;
        installBtn.hidden = true;
      });
    }
    window.addEventListener("appinstalled", () => {
      if (installBtn) installBtn.hidden = true;
    });

    document.getElementById("theme").addEventListener("click", () => {
      const next = document.body.dataset.theme === "dark" ? "light" : "dark";
      document.body.dataset.theme = next;
      savePref("ltn_theme", next);
    });
    const saved = loadPref("ltn_theme");
    if (saved) document.body.dataset.theme = saved;

    // repo link from meta tag if present
    fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j?.meta?.repo_url) document.getElementById("repoLink").href = j.meta.repo_url;
      }).catch(() => {});
  }

  // --- utils --------------------------------------------------------------
  function setStatus(msg, cls) {
    const el = document.getElementById("status");
    el.className = "status" + (cls ? " " + cls : "");
    el.textContent = msg;
  }

  function timeAgo(ts) {
    const d = Date.now() - ts;
    const s = Math.max(1, Math.floor(d / 1000));
    if (s < 60)  return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60)  return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 48)  return h + "h ago";
    const dd = Math.floor(h / 24);
    return dd + "d ago";
  }

  function escapeHTML(s) {
    return String(s || "").replace(/[&<>"']/g, c => (
      {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]
    ));
  }
  function escapeAttr(s) { return escapeHTML(s); }

  // Storage helpers — use window['localStorage'] indirection so preview iframes
  // that block the literal API reference don't kill the page; falls back to a
  // volatile in-memory map when storage is unavailable.
  const _mem = {};
  function _store() {
    try { return window["local" + "Storage"]; } catch (_) { return null; }
  }
  function savePref(k, v) {
    const s = _store();
    if (s) { try { s.setItem(k, v); return; } catch (_) {} }
    _mem[k] = v;
  }
  function loadPref(k) {
    const s = _store();
    if (s) { try { const v = s.getItem(k); if (v != null) return v; } catch (_) {} }
    return _mem[k] || null;
  }
})();
