# Tech, Blueprinted

Interactive, step-by-step visual guides to how software works inside. Starting with Postgres: pages, MVCC, B-tree indexes, VACUUM, HOT updates, TOAST and shared buffers. Runs entirely in your browser.

**Live site:** https://maulikkohli7.github.io/tech-blueprinted/

## What's inside

**Postgres** (16 tours, each on its own page under `/postgres/<tour>/`)

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

- Static files with no backend. GitHub Pages serves them as they are.
- Every page is pre-rendered HTML: its own title, description, canonical URL, Open Graph tags and schema.org data. Each tour page also has the whole tour written out as text, so it reads without JavaScript and search engines can index it.
- JavaScript then turns the tour page into the interactive stepper. A step is kept in the address, for example `postgres/mvcc/#3`.
- Links from the old single-page site (`#postgres`, `#versions/3`) redirect to the new pages.
- Tour progress is saved in the browser with `localStorage`. Nothing is sent anywhere.
- The simulator is deliberately small (4 tuples per page, no WAL, a rule-based planner). Each tour notes where real Postgres differs.

## Editing

Tour content lives in `assets/js/tours.js`. After changing it, regenerate the pages and commit the result:

```sh
node scripts/build.mjs
```

The site address used for canonical links and the sitemap defaults to `https://maulikkohli7.github.io/tech-blueprinted/`. For a custom domain, run `SITE_URL=https://example.com/ node scripts/build.mjs`.

## Deploying on GitHub Pages

Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then `main` and `/ (root)`. Then submit `sitemap.xml` in Google Search Console.

## Files

| File | Purpose |
|---|---|
| `index.html` | Homepage (generated) |
| `postgres/index.html` | Contents of the Postgres series (generated) |
| `postgres/<tour>/index.html` | One page per tour (generated) |
| `assets/js/tours.js` | Tour content: steps, SQL and notes |
| `assets/js/views.js` | HTML templates shared by the browser and the build script |
| `assets/js/engine.js` | The simulated Postgres |
| `assets/js/app.js` | The interactive stepper and drawings |
| `assets/css/site.css` | Styles |
| `assets/og.png`, `assets/favicon.svg` | Social preview image and icon |
| `scripts/build.mjs` | Generates the pages, `404.html`, `robots.txt` and `sitemap.xml` |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
