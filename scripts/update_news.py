#!/usr/bin/env python3
"""
update_news.py — ingestion + ranking for the Live Tech News Board.

- Pulls from many low-dependency sources (RSS + Hacker News Algolia API).
- Classifies each item into one of 4 lanes: gadgets, innovation, ai, science (tech-bent).
- Deduplicates by canonical URL + normalized title hash.
- Ranks with an "impact / less-circulated" bias and a paywall penalty.
- Merges into data/news.json using a FILO (first-in/last-out) per-lane bounded queue:
    new items inserted at the FRONT; tail items evicted when the lane exceeds LANE_CAP.
- Prunes items older than RETAIN_DAYS (default 90).
- Writes a single data/news.json snapshot.

Dependencies: only `feedparser` and the stdlib. Install with:
    pip install feedparser

Environment (optional):
    NEWSAPI_KEY            If set, also queries newsapi.org for extra coverage.
    LTN_REPO_URL           Baked into news.json meta so the UI footer links to the repo.
    LTN_LANE_CAP           Override per-lane queue cap (default 60).
    LTN_RETAIN_DAYS        Override archive retention window (default 90).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable

try:
    import feedparser  # type: ignore
except ImportError:
    print("ERROR: feedparser is required. Install with: pip install feedparser", file=sys.stderr)
    sys.exit(2)


# ------------------------------------------------------------------ Config

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "news.json"

LANE_CAP = int(os.environ.get("LTN_LANE_CAP", "60"))       # how many items to retain per lane
RETAIN_DAYS = int(os.environ.get("LTN_RETAIN_DAYS", "90")) # archive retention window
USER_AGENT = "live-tech-news-bot/1.0 (+https://github.com)"
HTTP_TIMEOUT = 20

# Source trust weights bias ranking. Lower = more "less-circulated" boost.
# Mainstream outlets still pass through, but niche outlets get a lift.
SOURCE_WEIGHT = {
    # mainstream tech
    "TechCrunch": 0.85,
    "The Verge": 0.90,
    "Ars Technica": 0.95,
    "Wired": 0.88,
    "Engadget": 0.80,
    "Mashable": 0.70,
    "CNET": 0.82,
    "TechRadar": 0.85,
    "The Next Web": 0.90,
    "Recode": 0.92,
    # aggregators / commentary
    "Techmeme": 1.00,
    "Slashdot": 1.05,
    "Daring Fireball": 1.08,
    "MakeUseOf": 0.85,
    "ReadWrite": 0.90,
    "Digg": 0.90,
    "Reddit r/technology": 0.95,
    # apple / android niche
    "Mac Rumors": 1.00,
    "Android Police": 1.00,
    # research / quality
    "MIT Technology Review": 1.05,
    "IEEE Spectrum": 1.10,
    "Nature": 1.15,
    "Quanta Magazine": 1.15,
    "Phys.org": 1.02,
    "ScienceDaily": 1.00,
    "arXiv cs.AI": 1.05,
    "arXiv cs.LG": 1.05,
    # industry / niche
    "Hacker News": 1.05,
    "The Register": 1.05,
    "Hackaday": 1.08,
    "Tom's Hardware": 0.95,
    "AnandTech": 1.02,
    "Liliputing": 1.10,
    "NewsAPI": 0.85,
}

# Known paywall-heavy domains (down-weight; still allowed if high-impact).
PAYWALL_DOMAINS = {
    "wsj.com", "nytimes.com", "ft.com", "bloomberg.com", "economist.com",
    "theinformation.com", "wired.com", "newyorker.com",
}

# Very roughly: "heavily circulated" outlets get a mild penalty to honor the
# "prioritize less circulated impactful" requirement.
MAINSTREAM_DOMAINS = {
    "techcrunch.com", "theverge.com", "engadget.com", "mashable.com",
    "cnn.com", "bbc.com", "reuters.com",
}

# RSS feed list grouped by likely lane (classifier can override per-item).
# Source set inspired by techurls.com plus research/niche outlets.
FEEDS: list[tuple[str, str, str]] = [
    # (source_name, url, default_lane)
    # Gadgets
    ("Ars Technica",       "https://feeds.arstechnica.com/arstechnica/gadgets",     "gadgets"),
    ("The Verge",          "https://www.theverge.com/rss/index.xml",               "gadgets"),
    ("Engadget",           "https://www.engadget.com/rss.xml",                      "gadgets"),
    ("Tom's Hardware",     "https://www.tomshardware.com/feeds/all",                "gadgets"),
    ("Liliputing",         "https://liliputing.com/feed",                           "gadgets"),
    ("CNET",               "https://www.cnet.com/rss/news/",                        "gadgets"),
    ("TechRadar",          "https://www.techradar.com/rss",                         "gadgets"),
    ("Mac Rumors",         "https://www.macrumors.com/macrumors.xml",               "gadgets"),
    ("Android Police",     "https://www.androidpolice.com/feed/",                   "gadgets"),

    # Innovation
    ("MIT Technology Review", "https://www.technologyreview.com/feed/",             "innovation"),
    ("Hackaday",           "https://hackaday.com/feed/",                            "innovation"),
    ("IEEE Spectrum",      "https://spectrum.ieee.org/feeds/feed.rss",              "innovation"),
    ("TechCrunch",         "https://techcrunch.com/feed/",                          "innovation"),
    ("The Register",       "https://www.theregister.com/headlines.atom",            "innovation"),
    ("The Next Web",       "https://thenextweb.com/feed",                           "innovation"),
    ("ReadWrite",          "https://readwrite.com/feed/",                           "innovation"),
    ("MakeUseOf",          "https://www.makeuseof.com/feed/",                       "innovation"),
    ("Techmeme",           "https://www.techmeme.com/feed.xml",                     "innovation"),
    ("Daring Fireball",    "https://daringfireball.net/feeds/main",                 "innovation"),
    ("Slashdot",           "https://rss.slashdot.org/Slashdot/slashdotMain",        "innovation"),

    # AI
    ("Ars Technica AI",    "https://feeds.arstechnica.com/arstechnica/index/",      "ai"),
    ("MIT Tech Review AI", "https://www.technologyreview.com/topic/artificial-intelligence/feed", "ai"),
    ("arXiv cs.AI",        "http://export.arxiv.org/rss/cs.AI",                     "ai"),
    ("arXiv cs.LG",        "http://export.arxiv.org/rss/cs.LG",                     "ai"),

    # Science (with tech bent)
    ("Ars Technica Science","https://feeds.arstechnica.com/arstechnica/science",    "science"),
    ("Quanta Magazine",    "https://www.quantamagazine.org/feed/",                  "science"),
    ("Phys.org",           "https://phys.org/rss-feed/",                            "science"),
    ("ScienceDaily Tech",  "https://www.sciencedaily.com/rss/matter_energy/engineering.xml", "science"),
    ("Nature",             "https://www.nature.com/nature.rss",                     "science"),

    # Community / broad
    ("Reddit r/technology", "https://www.reddit.com/r/technology/.rss",             "innovation"),
]

# Lane classification keywords (used to reclassify or confirm a feed's default lane).
LANE_KEYWORDS = {
    "ai": [
        "ai", "a.i.", "artificial intelligence", "llm", "large language model",
        "gpt", "gemini", "claude", "mistral", "llama", "openai", "anthropic",
        "deepmind", "hugging face", "transformer", "diffusion model", "neural net",
        "machine learning", "deep learning", "agent", "agents", "rag", "fine-tune",
        "inference", "tensor", "embedding", "chatbot", "copilot",
    ],
    "gadgets": [
        "phone", "smartphone", "laptop", "tablet", "headphones", "earbuds",
        "smartwatch", "wearable", "monitor", "keyboard", "mouse", "vr", "ar",
        "headset", "camera", "drone", "e-reader", "smart glasses", "foldable",
        "gpu", "ssd", "router", "cpu", "handheld", "console", "charger",
    ],
    "science": [
        "physics", "biology", "chemistry", "neuroscience", "quantum",
        "cosmology", "astronomy", "space", "nasa", "spacex", "rocket",
        "fusion", "climate", "materials", "genome", "crispr", "vaccine",
        "microbiome", "ecology", "paleontology", "mathematics",
    ],
    "innovation": [
        "startup", "raised", "funding", "series a", "series b", "launches",
        "unveils", "breakthrough", "prototype", "patent", "robotics", "robot",
        "manufacturing", "supply chain", "biotech", "cleantech", "battery",
        "solar", "ev", "autonomous", "open source", "open-source",
    ],
}

# Extra tech-angle cue: science items with these keywords are kept; without any
# keyword they're still allowed but get a small boost when they overlap with
# hardware/software/engineering themes.
SCIENCE_TECH_CUES = [
    "quantum", "chip", "processor", "laser", "sensor", "robot", "satellite",
    "rocket", "launch", "fusion", "battery", "material", "semiconductor",
    "ai", "machine learning", "algorithm", "software", "biotech", "genome",
    "crispr", "neural",
]


# ------------------------------------------------------------------ Model

@dataclass
class Article:
    id: str
    title: str
    url: str
    source: str
    lane: str
    published_ts: int               # epoch ms
    summary: str = ""
    tags: list[str] = field(default_factory=list)
    paywall: bool = False
    impact: str = "normal"          # "high" | "normal"
    score: float = 0.0

    def to_public(self) -> dict:
        # Keep snapshot slim — omit raw internals the UI doesn't use.
        return {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "source": self.source,
            "lane": self.lane,
            "published_ts": self.published_ts,
            "summary": self.summary[:400],
            "tags": self.tags[:6],
            "paywall": self.paywall,
            "impact": self.impact,
            "score": round(self.score, 4),
        }


# ------------------------------------------------------------------ Fetch

def http_get(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def fetch_feed(name: str, url: str, default_lane: str) -> list[Article]:
    out: list[Article] = []
    try:
        raw = http_get(url)
    except Exception as e:
        print(f"[warn] fetch failed {name}: {e}", file=sys.stderr)
        return out
    try:
        parsed = feedparser.parse(raw)
    except Exception as e:
        print(f"[warn] parse failed {name}: {e}", file=sys.stderr)
        return out
    for entry in parsed.entries[:40]:
        a = entry_to_article(entry, name, default_lane)
        if a:
            out.append(a)
    return out


def fetch_hacker_news() -> list[Article]:
    """Pull top stories from HN via Algolia API — signal for 'impactful' items."""
    url = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50"
    try:
        raw = http_get(url)
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        print(f"[warn] hacker news fetch failed: {e}", file=sys.stderr)
        return []
    out: list[Article] = []
    for hit in data.get("hits", []):
        title = (hit.get("title") or "").strip()
        url = (hit.get("url") or "").strip()
        if not title or not url:
            continue
        ts = int((hit.get("created_at_i") or time.time())) * 1000
        points = int(hit.get("points") or 0)
        lane = classify_lane(title, "")
        if lane is None:
            continue  # skip non-tech HN items
        a = Article(
            id=make_id(url, title),
            title=clean_text(title),
            url=url,
            source="Hacker News",
            lane=lane,
            published_ts=ts,
            summary="",
            tags=["hn", f"points:{points}"],
            paywall=is_paywalled(url),
        )
        # HN front page is the signal; high points → mark high impact.
        if points >= 150:
            a.impact = "high"
        out.append(a)
    return out


def fetch_newsapi() -> list[Article]:
    """Optional: query newsapi.org if NEWSAPI_KEY is set."""
    key = os.environ.get("NEWSAPI_KEY", "").strip()
    if not key:
        return []
    qs = urllib.parse.urlencode({
        "category": "technology",
        "language": "en",
        "pageSize": 50,
        "apiKey": key,
    })
    url = "https://newsapi.org/v2/top-headlines?" + qs
    try:
        raw = http_get(url)
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        print(f"[warn] newsapi fetch failed: {e}", file=sys.stderr)
        return []
    out: list[Article] = []
    for art in data.get("articles", []):
        title = (art.get("title") or "").strip()
        u = (art.get("url") or "").strip()
        src = ((art.get("source") or {}).get("name") or "NewsAPI").strip()
        if not title or not u:
            continue
        ts = _parse_iso(art.get("publishedAt")) or int(time.time() * 1000)
        lane = classify_lane(title, art.get("description") or "")
        if lane is None:
            continue
        out.append(Article(
            id=make_id(u, title),
            title=clean_text(title),
            url=u,
            source=src,
            lane=lane,
            published_ts=ts,
            summary=clean_text(art.get("description") or "")[:300],
            tags=["newsapi"],
            paywall=is_paywalled(u),
        ))
    return out


def entry_to_article(entry, source: str, default_lane: str) -> Article | None:
    title = clean_text(getattr(entry, "title", "") or "")
    link = getattr(entry, "link", "") or ""
    if not title or not link:
        return None

    summary_raw = getattr(entry, "summary", "") or getattr(entry, "description", "") or ""
    summary = clean_text(strip_html(summary_raw))

    published_ts = _entry_time(entry)

    # Reclassify: if the title/summary strongly matches another lane, use that.
    inferred = classify_lane(title, summary)
    lane = inferred or default_lane

    # Science feeds: keep only items with a tech bent.
    if lane == "science" and not _has_tech_cue(title + " " + summary):
        # demote to tagged item but still allow — some core science is useful
        pass

    tags = [t.get("term") for t in getattr(entry, "tags", []) or [] if t.get("term")]
    tags = [t.lower() for t in tags][:6]

    return Article(
        id=make_id(link, title),
        title=title,
        url=link,
        source=source,
        lane=lane,
        published_ts=published_ts,
        summary=summary[:400],
        tags=tags,
        paywall=is_paywalled(link),
    )


def _entry_time(entry) -> int:
    for k in ("published_parsed", "updated_parsed", "created_parsed"):
        v = getattr(entry, k, None)
        if v:
            try:
                return int(time.mktime(v)) * 1000
            except Exception:
                pass
    # fall back to string fields
    for k in ("published", "updated", "created"):
        s = getattr(entry, k, None)
        if s:
            ts = _parse_iso(s)
            if ts:
                return ts
    return int(time.time() * 1000)


def _parse_iso(s: str | None) -> int | None:
    if not s:
        return None
    try:
        s2 = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s2)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


# ------------------------------------------------------------------ Classify / rank

_WORD_RE_CACHE: dict[str, re.Pattern] = {}

def _kw_pattern(word: str) -> re.Pattern:
    p = _WORD_RE_CACHE.get(word)
    if p is None:
        # word-boundary match, allows punctuation/hyphens inside compound terms
        p = re.compile(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])", re.IGNORECASE)
        _WORD_RE_CACHE[word] = p
    return p


def classify_lane(title: str, summary: str) -> str | None:
    title_l = title.lower()
    text = title_l + " " + summary.lower()
    scores = {k: 0 for k in LANE_KEYWORDS}
    for lane, words in LANE_KEYWORDS.items():
        for w in words:
            pat = _kw_pattern(w)
            if pat.search(text):
                scores[lane] += 2 if pat.search(title_l) else 1
    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] == 0:
        return None
    return best[0]


def _has_tech_cue(text: str) -> bool:
    t = text.lower()
    return any(_kw_pattern(k).search(t) for k in SCIENCE_TECH_CUES)


def is_paywalled(url: str) -> bool:
    host = urllib.parse.urlparse(url).netloc.lower().lstrip("www.")
    return any(host.endswith(d) for d in PAYWALL_DOMAINS)


def _is_mainstream(url: str) -> bool:
    host = urllib.parse.urlparse(url).netloc.lower().lstrip("www.")
    return any(host.endswith(d) for d in MAINSTREAM_DOMAINS)


def rank(a: Article) -> float:
    now_ms = int(time.time() * 1000)
    age_h = max(0.0, (now_ms - a.published_ts) / 3_600_000.0)
    # Recency: exponential decay, half-life ~36h
    recency = pow(0.5, age_h / 36.0)

    trust = SOURCE_WEIGHT.get(a.source, 1.0)

    # "less-circulated but impactful" bias:
    #   - mainstream domains: -12%
    #   - explicit high-impact signal (e.g. HN >=150 pts): +25%
    circ = 0.88 if _is_mainstream(a.url) else 1.0
    impact_boost = 1.25 if a.impact == "high" else 1.0

    # Paywall penalty (still allowed through, but demoted).
    paywall_penalty = 0.75 if a.paywall else 1.0

    # Tech-bent cue helps science entries in particular.
    cue_boost = 1.08 if _has_tech_cue(a.title + " " + a.summary) else 1.0

    return recency * trust * circ * impact_boost * paywall_penalty * cue_boost


# ------------------------------------------------------------------ Utils

def make_id(url: str, title: str) -> str:
    norm = _canonical_url(url) + "|" + re.sub(r"\s+", " ", title.strip().lower())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def _canonical_url(url: str) -> str:
    try:
        p = urllib.parse.urlparse(url)
        # drop common tracking params
        q = [
            (k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
            if not k.lower().startswith(("utm_", "mc_", "ref", "ref_"))
            and k.lower() not in ("fbclid", "gclid", "mkt_tok")
        ]
        return urllib.parse.urlunparse((
            p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"),
            "", urllib.parse.urlencode(q), "",
        ))
    except Exception:
        return url.strip()


_TAG_RE = re.compile(r"<[^>]+>")
def strip_html(s: str) -> str:
    return _TAG_RE.sub("", s or "")


def clean_text(s: str) -> str:
    s = html.unescape(s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ------------------------------------------------------------------ Merge / persist

def load_snapshot() -> dict:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[warn] existing snapshot unreadable, starting fresh: {e}", file=sys.stderr)
    return {"generated_at": None, "lanes": {k: [] for k in ["gadgets","innovation","ai","science"]}, "meta": {}}


def merge_into_lane(existing: list[dict], fresh: list[Article]) -> list[dict]:
    """
    FILO per-lane bounded queue:
      - New items (not already present) inserted at the FRONT.
      - If length exceeds LANE_CAP, tail items are evicted (oldest-out).
    Also re-sorts primarily by published_ts desc so the visual order stays newest-first
    even if a source backfills an older item. Purely tail-eviction still applies on cap.
    """
    by_id = {it["id"]: it for it in existing}
    new_inserts: list[dict] = []
    for a in fresh:
        pub = a.to_public()
        if a.id in by_id:
            # Keep the earlier record but refresh fields that may improve.
            prev = by_id[a.id]
            prev["score"] = max(prev.get("score", 0), pub["score"])
            prev["impact"] = "high" if "high" in (prev.get("impact",""), pub["impact"]) else "normal"
            if not prev.get("summary") and pub.get("summary"):
                prev["summary"] = pub["summary"]
            continue
        new_inserts.append(pub)
        by_id[a.id] = pub

    # FRONT-insert new, then all prior items, then sort by published_ts desc.
    merged = new_inserts + existing
    merged.sort(key=lambda it: (it.get("published_ts") or 0), reverse=True)

    # Prune older than retention window.
    cutoff = int((datetime.now(timezone.utc) - timedelta(days=RETAIN_DAYS)).timestamp() * 1000)
    merged = [it for it in merged if (it.get("published_ts") or 0) >= cutoff]

    # Enforce lane cap (evict tail = oldest).
    if len(merged) > LANE_CAP:
        merged = merged[:LANE_CAP]
    return merged


def write_snapshot(snapshot: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(DATA_FILE)


# ------------------------------------------------------------------ Main

def main() -> int:
    print(f"[info] live-tech-news update @ {datetime.now(timezone.utc).isoformat()}")
    print(f"[info] LANE_CAP={LANE_CAP} RETAIN_DAYS={RETAIN_DAYS}")

    all_fresh: list[Article] = []

    # RSS sources
    for name, url, lane in FEEDS:
        items = fetch_feed(name, url, lane)
        print(f"  - {name}: {len(items)} items")
        all_fresh.extend(items)

    # Hacker News (less-circulated impact signal)
    hn = fetch_hacker_news()
    print(f"  - Hacker News: {len(hn)} items")
    all_fresh.extend(hn)

    # Optional: NewsAPI if key is set
    na = fetch_newsapi()
    if na:
        print(f"  - NewsAPI: {len(na)} items")
        all_fresh.extend(na)

    # De-dup by id (and by canonical URL collision)
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    deduped: list[Article] = []
    for a in all_fresh:
        if a.id in seen_ids:
            continue
        cu = _canonical_url(a.url)
        if cu in seen_urls:
            continue
        seen_ids.add(a.id); seen_urls.add(cu)
        deduped.append(a)

    # Score + assign impact flag by top quartile within lane
    for a in deduped:
        a.score = rank(a)

    # Bucket by lane for impact thresholding
    by_lane: dict[str, list[Article]] = {"gadgets": [], "innovation": [], "ai": [], "science": []}
    for a in deduped:
        if a.lane in by_lane:
            by_lane[a.lane].append(a)

    for lane, items in by_lane.items():
        if len(items) >= 8:
            cutoff_score = sorted(items, key=lambda x: x.score, reverse=True)[max(1, len(items)//4) - 1].score
            for a in items:
                if a.score >= cutoff_score and a.impact != "high":
                    a.impact = "high"

    # Merge into persistent snapshot
    snapshot = load_snapshot()
    for lane in ["gadgets", "innovation", "ai", "science"]:
        snapshot.setdefault("lanes", {}).setdefault(lane, [])
        snapshot["lanes"][lane] = merge_into_lane(snapshot["lanes"][lane], by_lane.get(lane, []))

    snapshot["generated_at"] = datetime.now(timezone.utc).isoformat()
    snapshot["meta"] = {
        "lane_cap": LANE_CAP,
        "retain_days": RETAIN_DAYS,
        "sources": sorted({s for s, _, _ in FEEDS} | {"Hacker News"} | ({"NewsAPI"} if na else set())),
        "repo_url": os.environ.get("LTN_REPO_URL", "https://github.com/"),
    }

    write_snapshot(snapshot)
    totals = {k: len(snapshot["lanes"][k]) for k in ["gadgets","innovation","ai","science"]}
    print(f"[done] wrote {DATA_FILE.relative_to(ROOT)} · totals={totals}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
