# live-tech-news

A rotating, live-ish tech news board deployable to GitHub Pages. Four lanes
(**Gadgets · Innovation · AI · Science with a tech bent**) each show 3–5
headlines at a time, newest on top, fuzzy-searchable, auto-refreshing, with a
90-day rolling archive and a FILO per-lane queue.

No backend. Everything runs as a static site plus one scheduled GitHub Action.

---

## TL;DR

- **UI:** `index.html` + vanilla JS + Fuse.js CDN. No build step.
- **Data:** `data/news.json` — a single JSON snapshot the browser polls.
- **Ingestor:** `scripts/update_news.py` pulls RSS from ~19 sources plus the
  Hacker News Algolia API (optionally NewsAPI), classifies items into the 4
  lanes, dedupes by canonical URL and title hash, ranks with an
  impact/less-circulated bias, penalizes paywalls, enforces a 60-item-per-lane
  FILO queue, prunes anything older than 90 days, and rewrites `data/news.json`.
- **Refresh:** `.github/workflows/refresh-news.yml` runs the ingestor on a
  30-minute cron and commits the updated snapshot back to `main`. GitHub Pages
  redeploys automatically via `.github/workflows/pages.yml`.

## Screens

The board renders at `https://<you>.github.io/live-tech-news/` after first
deploy. Each lane rotates through its archive every 9 seconds; the page
re-fetches `news.json` every 5 minutes.

## Architecture

```
live-tech-news/
├── index.html                # the dashboard
├── assets/
│   ├── css/style.css         # dark/light theme, responsive grid
│   └── js/app.js             # lane rendering, rotation, polling, Fuse search
├── data/
│   └── news.json             # snapshot written by the ingestor
├── scripts/
│   ├── update_news.py        # ingestion + ranking + FILO merge
│   └── requirements.txt      # feedparser
└── .github/workflows/
    ├── refresh-news.yml      # cron → run ingestor → commit snapshot
    └── pages.yml             # deploy to GitHub Pages on push
```

### Lane queue model (FILO)

Each lane is a bounded queue, default cap **60** (override with
`LTN_LANE_CAP`). Ingestion workflow per run:

1. Fetch + classify + dedupe fresh items.
2. Front-insert new items (First-In), keep existing items.
3. Re-sort by publish time, newest first.
4. Prune anything older than `LTN_RETAIN_DAYS` (default 90 days).
5. Truncate the tail when the lane exceeds `LTN_LANE_CAP` (Last-Out).

In the browser, each lane displays 5 visible items and cycles through the full
retained archive on a timer, so you see headlines rotate in and out while the
full 90 days remains fuzzy-searchable.

### Ranking

`rank(item) = recency × source_trust × circulation × impact × paywall × cue`

- `recency` — exponential decay, ~36-hour half-life.
- `source_trust` — per-outlet weight (research/niche outlets boosted, mass
  outlets neutral).
- `circulation` — mainstream domains get a ~12% penalty to honor
  *prioritize less-circulated impactful news*.
- `impact` — `+25%` if the item is flagged high-impact (HN ≥150 points, or top
  quartile of its lane).
- `paywall` — `−25%` if the domain is in `PAYWALL_DOMAINS`. Still allowed
  through so globally important paywalled stories aren't lost.
- `cue` — `+8%` when science items have a hardware/software/engineering angle.

### Sources (default)

Gadgets: Ars Technica, The Verge, Engadget, Tom's Hardware, Liliputing.
Innovation: MIT Tech Review, Hackaday, IEEE Spectrum, TechCrunch, The Register.
AI: Ars Technica AI, MIT Tech Review AI, arXiv cs.AI, arXiv cs.LG.
Science (tech-bent): Ars Technica Science, Quanta Magazine, Phys.org,
ScienceDaily Engineering, Nature. Plus Hacker News front page across all lanes.

Set `NEWSAPI_KEY` (repo secret) to add NewsAPI as an extra source.

## Local development

```bash
# one-time
pip install -r scripts/requirements.txt

# regenerate the data snapshot against live sources
python scripts/update_news.py

# serve locally — then open http://127.0.0.1:8765
python -m http.server 8765
```

## Deploying to GitHub Pages

One-shot from the project root (macOS/Linux). Replace `YOURNAME` with your
GitHub username.

```bash
# 1) Create an empty repo on github.com called "live-tech-news" first.
# 2) Then from inside this folder:

cd live-tech-news
git init -b main
git add .
git commit -m "chore: initial live-tech-news import"
git remote add origin git@github.com:YOURNAME/live-tech-news.git
git push -u origin main
```

Using HTTPS + a personal access token instead of SSH:

```bash
git remote add origin https://github.com/YOURNAME/live-tech-news.git
git push -u origin main
# (paste your token when prompted for a password)
```

Then in your repo settings on github.com:

1. **Settings → Pages → Build and deployment → Source: "GitHub Actions".**
   The included `pages.yml` workflow will deploy on every push.
2. **Settings → Actions → General → Workflow permissions → Read and write
   permissions.** Required so the refresh workflow can commit the updated
   `data/news.json` back to `main`.
3. (Optional) **Settings → Secrets and variables → Actions → New repository
   secret → `NEWSAPI_KEY`** if you want to enable NewsAPI ingestion.

The first `pages.yml` run will publish the site. The first `refresh-news.yml`
run (or your manual `workflow_dispatch`) will commit a fresh `data/news.json`.

## Manual refresh

- In GitHub: **Actions → Refresh news → Run workflow**.
- Locally: `python scripts/update_news.py && git add data/news.json && git commit -m "chore(data): refresh" && git push`

## Tuning

| env var            | default | purpose                                  |
|--------------------|---------|------------------------------------------|
| `LTN_LANE_CAP`     | `60`    | Max items retained per lane              |
| `LTN_RETAIN_DAYS`  | `90`    | Archive retention window                 |
| `LTN_REPO_URL`     | —       | Shown in the footer "View repo" link     |
| `NEWSAPI_KEY`      | —       | Enable NewsAPI ingestion                 |

In `assets/js/app.js`:

- `VISIBLE_PER_LANE` — how many items on screen per lane (default 5).
- `ROTATION_MS` — per-lane rotation cadence (default 9000 ms).
- `POLL_MS` — how often the UI re-fetches `news.json` (default 5 min).

## License

MIT. Do what you like.
