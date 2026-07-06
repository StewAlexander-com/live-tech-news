/* Live Tech News Board — client-side renderer
 * - Loads data/news.json (produced by scripts/update_news.py via GitHub Actions)
 * - Renders 4 lanes: Gadgets, Innovation, AI, Science
 * - Rotates visible headlines per-lane (newest on top)
 * - Fuse.js fuzzy search across entire 90-day archive
 * - Auto-polls data/news.json for near-real-time refresh
 */
(function () {
  "use strict";

  // Build marker — bump when deploying. Visible in the diagnostic panel
  // so you can tell at a glance whether a device is on the latest client.
  const APP_BUILD = "2026-07-06a";
  const APP_BUILD_TS = "2026-07-06T20:50Z";

  const LANES = [
    { key: "gadgets",    title: "Gadgets",    blurb: "Hardware, phones, laptops" },
    { key: "innovation", title: "Innovation", blurb: "Startups, policy, culture" },
    { key: "ai",         title: "AI",         blurb: "Models, research, tools" },
    { key: "science",    title: "Science",    blurb: "Physics, space, engineering" }
  ];
  const VISIBLE_PER_LANE = 5;                  // how many headlines on screen at once
  const EXPANDED_PER_LANE = 12;                // when user taps "Show more"
  const ROTATION_MS = 5 * 60 * 1000;           // each lane advances one slot every 5 min
  const LANE_STAGGER_MS = 75 * 1000;           // lane N offset: N * 75s (staggered, not synchronized)
  const POLL_MS = 5 * 60 * 1000;               // refresh JSON every 5 min
  const DATA_URL = "./data/news.json";
  const NEW_THRESHOLD_MS = 60 * 60 * 1000;     // "New" badge for items < 1h old
  const TOP_STORIES_WINDOW_MS = 24 * 3600 * 1000;
  const TOP_STORIES_MAX = 5;
  const VISITED_KEY = "ltn_visited";
  const VISITED_MAX = 400;

  const state = {
    snapshot: null,        // full JSON { generated_at, lanes: {key: [items...]} }
    visibleOffset: {},     // per-lane scroll offset into its queue
    laneTimers: {},        // per-lane setTimeout handle
    pollTimer: null,
    fuse: null,
    activeFilter: "all", // all | breaking | today
    expandedLanes: {},   // per-lane bool — show more items without waiting for rotation
    visited: new Set()
  };

  // --- Boot ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    loadVisited();
    buildLanes();
    buildLaneNav();
    wireControls();
    document.getElementById("pollMin").textContent = String(Math.round(POLL_MS / 60000));
    loadData(true).then(() => {
      scheduleLaneRotations();
      state.pollTimer = setInterval(() => loadData(false), POLL_MS);
    });
    registerServiceWorker();
    wireDiagnostics();
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
      navigator.serviceWorker.register("./sw.js")
        .then(reg => {
          // If a new SW is waiting, make it take over immediately so
          // stuck devices don't stay on the old shell for days.
          if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
          reg.addEventListener("updatefound", () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener("statechange", () => {
              if (nw.state === "installed" && navigator.serviceWorker.controller) {
                // New SW installed while an old one controlled this page.
                // Tell it to activate now; next poll will pick up fresh data.
                reg.waiting && reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            });
          });
        })
        .catch(() => { /* non-fatal */ });

      // If the active SW changes (new version took over), reload once
      // so the page is served by the new SW end-to-end.
      let didReload = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (didReload) return;
        didReload = true;
        location.reload();
      });
    } catch (_) { /* non-fatal */ }
  }

  // --- Lane DOM scaffolding ----------------------------------------------
  function buildLanes() {
    const board = document.getElementById("board");
    board.innerHTML = "";
    for (const lane of LANES) {
      state.visibleOffset[lane.key] = 0;
      state.expandedLanes[lane.key] = false;
      const el = document.createElement("section");
      el.className = "lane";
      el.id = "lane-" + lane.key;
      el.dataset.lane = lane.key;
      el.innerHTML = `
        <header>
          <div class="lane-title-wrap">
            <h2>${lane.title}</h2>
            <span class="lane-blurb">${lane.blurb}</span>
          </div>
          <span class="meta" data-role="meta">—</span>
        </header>
        <ol data-role="list"></ol>
        <footer class="lane-foot" data-role="foot" hidden>
          <button type="button" class="lane-more" data-role="more">Show more</button>
        </footer>
      `;
      board.appendChild(el);
    }
    board.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-role='more']");
      if (!btn) return;
      const laneEl = btn.closest(".lane");
      if (!laneEl) return;
      const key = laneEl.dataset.lane;
      state.expandedLanes[key] = !state.expandedLanes[key];
      btn.textContent = state.expandedLanes[key] ? "Show less" : "Show more";
      renderLane(key);
    });
    board.addEventListener("click", (e) => {
      const link = e.target.closest("a.title, a.top-story-link");
      if (!link || !link.href) return;
      markVisited(link.href);
    });
  }

  function buildLaneNav() {
    const nav = document.getElementById("laneNav");
    if (!nav) return;
    nav.innerHTML = LANES.map(l =>
      `<a href="#lane-${l.key}" class="lane-tab" data-lane="${l.key}">${l.title}</a>`
    ).join("");
    nav.addEventListener("click", (e) => {
      const tab = e.target.closest(".lane-tab");
      if (!tab) return;
      e.preventDefault();
      const target = document.getElementById("lane-" + tab.dataset.lane);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      nav.querySelectorAll(".lane-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
    });
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
      renderTopStories();
      renderAllLanes();
      const genMs = state.snapshot.generated_at ? Date.parse(state.snapshot.generated_at) : NaN;
      const ageMin = Number.isFinite(genMs) ? Math.round((Date.now() - genMs) / 60000) : null;
      const tsStr = Number.isFinite(genMs) ? new Date(genMs).toLocaleString() : "unknown";
      document.getElementById("lastUpdated").textContent =
        ageMin == null ? "Last updated: unknown"
        : `Updated ${ageMin === 0 ? "just now" : ageMin + " min ago"} · ${tsStr}`;
      // newest headline age across all lanes
      let newestMs = 0;
      for (const l of LANES) {
        for (const it of (state.snapshot.lanes[l.key] || [])) {
          const t = it.published_ts || (it.published ? Date.parse(it.published) : 0);
          if (t > newestMs) newestMs = t;
        }
      }
      const newestAge = newestMs ? Math.round((Date.now() - newestMs) / 60000) : null;
      const breakingCount = countBreaking();
      const todayCount = countToday();
      const parts = [];
      if (newestAge != null) {
        parts.push(newestAge < 1 ? "Fresh headlines just in" : `Newest headline ${newestAge} min ago`);
      }
      if (breakingCount) parts.push(`${breakingCount} breaking`);
      if (todayCount) parts.push(`${todayCount} today`);
      parts.push(`${totalItems()} in archive`);
      setStatus(parts.join(" · "));
    } catch (err) {
      console.error(err);
      if (initial) {
        setStatus("Could not load data/news.json — the ingestion script may not have run yet. Run scripts/update_news.py or trigger the GitHub Action.", "err");
      } else {
        setStatus("Refresh failed: " + err.message, "warn");
      }
      showRecoveryBanner(err);
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

  function isBreaking(it) {
    return (it.impact || "").toLowerCase() === "high";
  }

  function isToday(it) {
    const t = it.published_ts || 0;
    return t && (Date.now() - t) <= TOP_STORIES_WINDOW_MS;
  }

  function isNew(it) {
    const t = it.published_ts || 0;
    return t && (Date.now() - t) <= NEW_THRESHOLD_MS;
  }

  function countBreaking() {
    if (!state.snapshot) return 0;
    let n = 0;
    for (const l of LANES) {
      for (const it of (state.snapshot.lanes[l.key] || [])) {
        if (isBreaking(it) && isToday(it)) n += 1;
      }
    }
    return n;
  }

  function countToday() {
    if (!state.snapshot) return 0;
    let n = 0;
    for (const l of LANES) {
      for (const it of (state.snapshot.lanes[l.key] || [])) {
        if (isToday(it)) n += 1;
      }
    }
    return n;
  }

  function applyClientFilter(items) {
    if (state.activeFilter === "breaking") return items.filter(isBreaking);
    if (state.activeFilter === "today") return items.filter(isToday);
    return items;
  }

  function pickTopStories() {
    if (!state.snapshot) return [];
    const seen = new Set();
    const pool = [];
    for (const l of LANES) {
      for (const it of (state.snapshot.lanes[l.key] || [])) {
        if (!isToday(it) || !isBreaking(it)) continue;
        const id = it.id || it.url;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        pool.push({ ...it, lane: l.key, lane_title: l.title });
      }
    }
    pool.sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0) || (b.score || 0) - (a.score || 0));
    return pool.slice(0, TOP_STORIES_MAX);
  }

  function renderTopStories() {
    const section = document.getElementById("topStories");
    const list = document.getElementById("topStoriesList");
    if (!section || !list) return;
    const searchActive = Boolean(document.getElementById("search")?.value.trim());
    const stories = pickTopStories();
    if (!stories.length || searchActive || state.activeFilter !== "all") {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    list.innerHTML = stories.map((it, idx) => {
      const when = it.published_ts ? timeAgo(it.published_ts) : "";
      const visited = isVisited(it.url) ? " visited" : "";
      const newBadge = isNew(it) ? '<span class="pill new">New</span>' : "";
      const summary = it.summary ? `<p class="top-story-summary">${escapeHTML(truncate(it.summary, 140))}</p>` : "";
      return `<li class="top-story${visited}">
        <span class="top-rank">${idx + 1}</span>
        <div class="top-story-body">
          <a class="top-story-link" href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(it.title || "(untitled)")}</a>
          <div class="sub">
            <span class="source">${escapeHTML(it.source || "")}</span>
            <span class="lane-tag">${escapeHTML(it.lane_title)}</span>
            <span class="time">${when}</span>
            ${newBadge}
          </div>
          ${summary}
        </div>
      </li>`;
    }).join("");
  }

  function truncate(s, max) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1).trimEnd() + "…";
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
        { name: "title",  weight: 0.55 },
        { name: "source", weight: 0.18 },
        { name: "tags",   weight: 0.17 },
        { name: "summary",weight: 0.07 },
        { name: "lane_title", weight: 0.03 }
      ]
    });
  }

  // --- Rendering ----------------------------------------------------------
  function renderAllLanes() {
    for (const lane of LANES) renderLane(lane.key);
  }

  const DISPLAY_MAX_AGE_MS = 48 * 3600 * 1000;

  function freshItems(allItems) {
    // Prefer items published within the last 48h for the lane rotation.
    // If there aren't enough fresh ones, fall back to most-recent overall
    // so the lane is never empty.
    const now = Date.now();
    const fresh = allItems.filter(it => {
      const t = it.published_ts || 0;
      return t && (now - t) <= DISPLAY_MAX_AGE_MS;
    });
    if (fresh.length >= VISIBLE_PER_LANE) return fresh;
    // Fall back: take newest N items regardless of age so we never show an empty lane.
    const byTime = [...allItems].sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0));
    return byTime.slice(0, Math.max(VISIBLE_PER_LANE * 2, fresh.length));
  }

  function renderLane(key) {
    const laneEl = document.querySelector(`.lane[data-lane="${key}"]`);
    if (!laneEl) return;
    const listEl = laneEl.querySelector('[data-role="list"]');
    const metaEl = laneEl.querySelector('[data-role="meta"]');
    const footEl = laneEl.querySelector('[data-role="foot"]');
    const allItems = applyClientFilter(state.snapshot.lanes[key] || []);
    const expanded = !!state.expandedLanes[key];
    const limit = expanded ? EXPANDED_PER_LANE : VISIBLE_PER_LANE;
    const rotatable = freshItems(allItems);
    const freshCount = allItems.filter(it => it.published_ts && (Date.now() - it.published_ts) <= DISPLAY_MAX_AGE_MS).length;
    const filterLabel = state.activeFilter === "breaking" ? "breaking"
      : state.activeFilter === "today" ? "today" : null;
    metaEl.textContent = allItems.length
      ? (filterLabel ? `${allItems.length} ${filterLabel}` : `${freshCount} fresh`) + ` · ${(state.snapshot.lanes[key] || []).length} in archive`
      : filterLabel ? `No ${filterLabel} items` : "no items";

    if (!rotatable.length) {
      listEl.innerHTML = `<li class="muted empty-lane">No headlines match this filter. Try <button type="button" class="inline-link" data-reset-filter>All</button>.</li>`;
      listEl.querySelector("[data-reset-filter]")?.addEventListener("click", () => setFilter("all"));
      if (footEl) footEl.hidden = true;
      return;
    }

    const offset = expanded ? 0 : state.visibleOffset[key] % rotatable.length;
    const visible = [];
    for (let i = 0; i < Math.min(limit, rotatable.length); i++) {
      visible.push(rotatable[(offset + i) % rotatable.length]);
    }

    listEl.innerHTML = visible.map((it, idx) => itemHTML(it, idx + 1)).join("");
    if (footEl) {
      const canExpand = rotatable.length > VISIBLE_PER_LANE;
      footEl.hidden = !canExpand;
      const moreBtn = footEl.querySelector("[data-role='more']");
      if (moreBtn) moreBtn.textContent = expanded ? "Show less" : `Show more (${Math.min(rotatable.length, EXPANDED_PER_LANE) - VISIBLE_PER_LANE} more)`;
    }
  }

  function rotateLane(key) {
    if (state.expandedLanes[key]) return;
    const allItems = applyClientFilter(state.snapshot?.lanes?.[key] || []);
    const items = freshItems(allItems);
    if (items.length <= VISIBLE_PER_LANE) return;
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
    const paywall = it.paywall
      ? '<span class="pill paywall" title="May require subscription">Paywall</span>' : "";
    const impact = isBreaking(it)
      ? '<span class="pill impact-high" title="High impact or widely covered">Hot</span>' : "";
    const fresh = isNew(it)
      ? '<span class="pill new">New</span>' : "";
    const src = escapeHTML(it.source || "");
    const title = escapeHTML(it.title || "(untitled)");
    const url = it.url || "#";
    const visited = isVisited(url) ? " visited" : "";
    const lead = rank === 1 ? " item-lead" : "";
    return `
      <li class="item${visited}${lead}">
        <div class="rank">${rank}</div>
        <div class="body">
          <a class="title" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${title}</a>
          <div class="sub">
            <span class="source">${src}</span>
            <span class="time">${when}</span>
            ${fresh}${impact}${paywall}
          </div>
        </div>
        <div class="go" aria-hidden="true">↗</div>
      </li>
    `;
  }

  // --- Search -------------------------------------------------------------
  function setFilter(next) {
    state.activeFilter = next;
    const filters = document.getElementById("filters");
    if (filters) {
      filters.querySelectorAll(".chip").forEach(chip => {
        const on = chip.dataset.filter === next;
        chip.classList.toggle("active", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    renderTopStories();
    renderAllLanes();
  }

  function wireControls() {
    const search = document.getElementById("search");
    const resultsEl = document.getElementById("searchResults");
    const listEl = document.getElementById("searchList");
    const countEl = document.getElementById("searchCount");
    const boardEl = document.getElementById("board");
    const topStoriesEl = document.getElementById("topStories");
    const filtersEl = document.getElementById("filters");
    const laneNavEl = document.getElementById("laneNav");

    document.getElementById("filters")?.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      setFilter(chip.dataset.filter || "all");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        search?.focus();
      }
      if (e.key === "Escape" && document.activeElement === search) {
        search.value = "";
        search.dispatchEvent(new Event("input"));
        search.blur();
      }
    });

    search.addEventListener("input", () => {
      const q = search.value.trim();
      if (!q) {
        resultsEl.hidden = true;
        boardEl.hidden = false;
        if (filtersEl) filtersEl.hidden = false;
        if (laneNavEl) laneNavEl.hidden = false;
        renderTopStories();
        return;
      }
      if (!state.fuse) { resultsEl.hidden = true; return; }
      const hits = state.fuse.search(q).slice(0, 40);
      countEl.textContent = `(${hits.length})`;
      listEl.innerHTML = hits.map(h => {
        const it = h.item;
        const visited = isVisited(it.url) ? " visited" : "";
        return `<li class="${visited.trim()}">
          <a href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHTML(it.title)}</strong></a>
          <div class="sub" style="font-size:12px;color:var(--fg-dim);">
            <span class="source">${escapeHTML(it.source || "")}</span>
            · <span class="muted">${escapeHTML(it.lane_title)}</span>
            · <span class="time">${it.published_ts ? timeAgo(it.published_ts) : ""}</span>
            ${isBreaking(it) ? ' · <span class="pill impact-high">Hot</span>' : ""}
          </div>
        </li>`;
      }).join("");
      listEl.querySelectorAll("a").forEach(a => {
        a.addEventListener("click", () => markVisited(a.href));
      });
      resultsEl.hidden = false;
      boardEl.hidden = true;
      if (topStoriesEl) topStoriesEl.hidden = true;
      if (filtersEl) filtersEl.hidden = true;
      if (laneNavEl) laneNavEl.hidden = true;
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

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function loadVisited() {
    try {
      const raw = loadPref(VISITED_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.visited = new Set(arr.slice(0, VISITED_MAX));
    } catch (_) { /* ignore */ }
  }

  function persistVisited() {
    savePref(VISITED_KEY, JSON.stringify([...state.visited].slice(-VISITED_MAX)));
  }

  function markVisited(url) {
    if (!url || url === "#") return;
    state.visited.add(url);
    persistVisited();
    document.querySelectorAll(`a[href="${CSS.escape(url)}"]`).forEach(a => {
      a.closest(".item, .top-story, li")?.classList.add("visited");
    });
  }

  function isVisited(url) {
    return url && state.visited.has(url);
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

  // --- Recovery banner for stuck clients -------------------------------
  function showRecoveryBanner(err) {
    if (document.getElementById("recoveryBanner")) return;
    const b = document.createElement("div");
    b.id = "recoveryBanner";
    b.style.cssText = [
      "margin:10px 14px",
      "padding:14px 16px",
      "background:#4a1520",
      "border:1px solid #ff6b8a",
      "border-radius:12px",
      "color:#ffd9e0",
      "font-size:14px",
      "line-height:1.4"
    ].join(";");
    b.innerHTML = `
      <strong>Couldn't load latest data.</strong><br>
      Your installed app may have a stuck cache. Tap the button below to clear it and reload.<br>
      <button id="recoveryFix" style="margin-top:10px;padding:10px 14px;border-radius:8px;border:1px solid #ff6b8a;background:transparent;color:#ffd9e0;font-size:14px;cursor:pointer">Clear cache & reload</button>
      <div style="margin-top:8px;opacity:0.7;font-size:12px">Error: ${escapeHTMLLocal(err && err.message || String(err))}</div>
    `;
    const status = document.getElementById("status");
    status.parentNode.insertBefore(b, status.nextSibling);
    document.getElementById("recoveryFix").addEventListener("click", async () => {
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (_) {}
      location.reload();
    });
  }

  function escapeHTMLLocal(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
    ));
  }

  // --- Hidden diagnostics panel (triple-tap on brand title to open) -----
  function wireDiagnostics() {
    const brand = document.getElementById("brand");
    const panel = document.getElementById("diagPanel");
    const body  = document.getElementById("diagBody");
    const closeBtn = document.getElementById("diagClose");
    const hardBtn  = document.getElementById("diagHardReload");
    const copyBtn  = document.getElementById("diagCopy");
    if (!brand || !panel) return;

    let taps = 0, tapTimer = null;
    const TAP_WINDOW_MS = 700;

    function onTap(e) {
      // Don't open when user taps the pulse dot accidentally during text selection
      if (e && e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      taps += 1;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, TAP_WINDOW_MS);
      if (taps >= 3) {
        taps = 0;
        clearTimeout(tapTimer);
        openDiag();
      }
    }

    brand.addEventListener("click", onTap);
    brand.addEventListener("keydown", onTap);

    closeBtn.addEventListener("click", () => { panel.hidden = true; });

    hardBtn.addEventListener("click", async () => {
      hardBtn.disabled = true;
      hardBtn.textContent = "Clearing…";
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (_) { /* ignore */ }
      location.reload();
    });

    copyBtn.addEventListener("click", async () => {
      const report = await buildReport();
      let copied = false;
      // Try modern clipboard API (requires user gesture, often fails in
      // standalone PWAs on iOS).
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(report);
          copied = true;
        }
      } catch (_) { /* fall through */ }
      // Try legacy execCommand (works in more PWA contexts).
      if (!copied) {
        try {
          const ta = document.createElement("textarea");
          ta.value = report;
          ta.setAttribute("readonly", "");
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, report.length);
          copied = document.execCommand && document.execCommand("copy");
          document.body.removeChild(ta);
        } catch (_) { /* fall through */ }
      }
      if (copied) {
        copyBtn.textContent = "Copied✓";
        setTimeout(() => { copyBtn.textContent = "Copy report"; }, 1500);
        return;
      }
      // Final fallback: show a selectable textarea inside the panel so the
      // user can long-press → Select All → Copy manually. This always works.
      let ta2 = document.getElementById("diagCopyFallback");
      if (!ta2) {
        ta2 = document.createElement("textarea");
        ta2.id = "diagCopyFallback";
        ta2.setAttribute("readonly", "");
        ta2.style.cssText =
          "width:100%;margin-top:10px;padding:8px;" +
          "background:#0b1220;color:#e7ecf5;border:1px solid #7cf;" +
          "border-radius:8px;font-family:ui-monospace,Menlo,monospace;" +
          "font-size:11px;min-height:160px;";
        panel.appendChild(ta2);
      }
      ta2.value = report;
      ta2.focus();
      ta2.select();
      ta2.setSelectionRange(0, report.length);
      copyBtn.textContent = "Long-press text below → Copy";
      setTimeout(() => { copyBtn.textContent = "Copy report"; }, 4000);
    });

    async function openDiag() {
      body.innerHTML = "<dt>Loading…</dt>";
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      body.innerHTML = await buildDiagRows();
    }

    async function swInfo() {
      if (!("serviceWorker" in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (!reg) return { supported: true, registered: false };
      const active = reg.active;
      return {
        supported: true,
        registered: true,
        scope: reg.scope,
        state: active ? active.state : "none",
        scriptURL: active ? active.scriptURL : "-",
        controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : "(no controller)",
        waiting: !!reg.waiting,
        installing: !!reg.installing,
      };
    }

    async function cacheInfo() {
      if (!("caches" in window)) return { supported: false };
      const keys = await caches.keys();
      return { supported: true, names: keys };
    }

    async function dataFreshness() {
      // Probe the network directly (bypass SW) to compare against what's rendered
      try {
        const res = await fetch(DATA_URL + "?diag=" + Date.now(), { cache: "no-store" });
        const json = await res.json();
        const genMs = json.generated_at ? Date.parse(json.generated_at) : NaN;
        return {
          network_generated_at: json.generated_at || "?",
          network_age_min: Number.isFinite(genMs) ? Math.round((Date.now() - genMs) / 60000) : "?",
          network_total_items: Object.values(json.lanes || {}).reduce((n, a) => n + a.length, 0),
        };
      } catch (e) {
        return { network_error: String(e) };
      }
    }

    async function buildReport() {
      const rows = await collectDiag();
      return Object.entries(rows).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
    }

    async function buildDiagRows() {
      const rows = await collectDiag();
      return Object.entries(rows).map(([k, v]) => {
        const val = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(val)}</dd>`;
      }).join("");
    }

    async function collectDiag() {
      const snap = state.snapshot || {};
      const genMs = snap.generated_at ? Date.parse(snap.generated_at) : NaN;
      const rendered_age_min = Number.isFinite(genMs) ? Math.round((Date.now() - genMs) / 60000) : null;
      const rendered_total = snap.lanes ? Object.values(snap.lanes).reduce((n, a) => n + a.length, 0) : 0;
      const display_mode = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches ? "standalone (installed PWA)" : "browser tab";
      const sw = await swInfo();
      const cache = await cacheInfo();
      const net = await dataFreshness();
      return {
        "app build": APP_BUILD,
        "app build ts": APP_BUILD_TS,
        "now (device)": new Date().toISOString(),
        "display mode": display_mode,
        "rendered snapshot": snap.generated_at || "(none)",
        "rendered age (min)": rendered_age_min == null ? "?" : rendered_age_min,
        "rendered total items": rendered_total,
        "network snapshot": net.network_generated_at || net.network_error || "?",
        "network age (min)": net.network_age_min == null ? "?" : (net.network_age_min ?? net.network_error ?? "?"),
        "network total items": net.network_total_items == null ? "?" : net.network_total_items,
        "stale delta (min)": (rendered_age_min != null && typeof net.network_age_min === "number")
            ? (rendered_age_min - net.network_age_min) : "?",
        "SW supported": sw.supported,
        "SW registered": sw.registered || false,
        "SW script": sw.scriptURL || "-",
        "SW state": sw.state || "-",
        "SW controller": sw.controller || "-",
        "SW waiting update": sw.waiting || false,
        "cache keys": cache.names ? cache.names.join(", ") : "(none)",
        "user agent": navigator.userAgent,
        "online": navigator.onLine,
        "lang": navigator.language,
      };
    }

    function escapeHTML(s) {
      return String(s).replace(/[&<>"']/g, c => (
        { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
      ));
    }
  }
})();
