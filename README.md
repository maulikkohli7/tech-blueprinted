# Tech, Blueprinted

Interactive, step-by-step visual guides to how software works inside. Starting with Postgres: pages, MVCC, B-tree indexes, VACUUM, HOT updates, TOAST and shared buffers. Runs entirely in your browser.

**Live site:** https://YOUR-USERNAME.github.io/tech-blueprinted/

## What's inside

**Postgres** (16 tours)

| Section | Tours |
|---|---|
| Storage | Pages, ctid, MVCC |
| Concurrency | Snapshots, Isolation levels, Row locks |
| Cleanup | VACUUM, Long transactions |
| B-tree indexes | B-tree index, Multicolumn indexes, Dead index entries, Index-only scans, HOT updates |
| Space | Fillfactor, TOAST |
| Memory | Shared buffers |

**Coming soon:** Kafka, Redis, Git, Linux.

Each tour runs real SQL against a small simulated Postgres written in JavaScript and draws what changes: pages, line pointers, tuple headers (xmin, xmax, ctid), snapshots, B-tree entries, the visibility map, TOAST chunks and shared buffers.

## How it works

- One static page with no backend and no build step. Open `index.html` in a browser to run it locally.
- Tour progress is saved in the browser with `localStorage`. Nothing is sent anywhere.
- The simulator is deliberately small (4 tuples per page, no WAL, a rule-based planner). Each tour notes where real Postgres differs.

## Deploying on GitHub Pages

1. Push these files to the `main` branch.
2. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then `main` and `/ (root)`.
3. Replace `YOUR-USERNAME` in `robots.txt`, `sitemap.xml` and this README with your GitHub username (or your custom domain).

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole site: simulator, tours and interface |
| `404.html` | Shown for unknown addresses |
| `robots.txt`, `sitemap.xml` | Help search engines find the site |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
