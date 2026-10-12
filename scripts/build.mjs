// Writes the static pages of the site from the tour data in assets/js/tours.js.
//   node scripts/build.mjs
// Run it after changing a tour, then commit the generated files. The site itself has no build
// step at runtime: GitHub Pages serves the files as they are.
//
// SITE_URL is the public address of the site, ending in a slash. Override it with an environment
// variable if you move to a custom domain: SITE_URL=https://example.com/ node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = (process.env.SITE_URL || 'https://maulikkohli7.github.io/tech-blueprinted/').replace(/\/?$/, '/');
const SITE_NAME = 'Tech, Blueprinted';
const TODAY = new Date().toISOString().slice(0, 10);

// Load the same data and templates the browser uses.
const ctx = vm.createContext({});
for (const f of ['assets/js/tours.js', 'assets/js/views.js']) vm.runInContext(readFileSync(join(DIR, f), 'utf8'), ctx, { filename: f });
const { TOURS, GROUPS, siteHtml, homeHtml, tocHtml, storyHtml, walkHtml, esc, tourMinutes } =
  vm.runInContext('({ TOURS, GROUPS, siteHtml, homeHtml, tocHtml, storyHtml, walkHtml, esc, tourMinutes })', ctx);
const EMPTY = vm.runInContext('({ done: new Set(), last: null })', ctx);

// Plain text from a note: drop the backticks used for inline code.
const plain = s => s.replace(/`/g, '');
// Trim to a search-snippet length at a word boundary.
function clip(s, n = 158) {
  s = plain(s).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,;:.]$/, '') + '…';
}
const ldJson = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const crumbsLd = items => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
});

const LOGO = `<svg width="26" height="26" viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="28" height="28"/><path d="M3 17h14v14"/><path d="M17 17l14-14" stroke="var(--accent)"/></svg>`;

function layout({ path, root, title, description, page, tourId = '', crumb = false, contents = false, body, ld, engine = false, ogType = 'website' }) {
  const url = SITE_URL + path;
  return `<!doctype html>
<html lang="en" data-skin="blueprint">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0E2A46">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE_URL}assets/og.png">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,400..800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${root}assets/css/site.css">
${ldJson({ '@context': 'https://schema.org', '@graph': ld })}
<script defer src="${root}assets/js/tours.js"></script>
<script defer src="${root}assets/js/views.js"></script>
${engine ? `<script defer src="${root}assets/js/engine.js"></script>\n` : ''}<script defer src="${root}assets/js/app.js"></script>
</head>
<body data-page="${page}" data-root="${root}"${tourId ? ` data-tour="${tourId}"` : ''}>
<a class="skip" href="#content">Skip to content</a>
<header class="masthead"><div class="top-in">
  <div class="brand"><a href="${root}" class="logo">${LOGO}<b>${SITE_NAME}</b></a>${crumb ? `<span class="crumb">/ <a href="${root}postgres/">Postgres</a></span>` : ''}${contents ? `<a class="contents-link" href="${root}postgres/">All Postgres tours</a>` : ''}</div>
  <div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center"><div class="toggles" id="toggles"></div></div>
</div></header>
${body}
<footer class="foot"><div>
  <p><a href="${root}">${SITE_NAME}</a>: interactive, step-by-step visual guides to how software works inside.</p>
  <p><a href="${root}postgres/">All Postgres tours</a> · Runs entirely in your browser. Progress is saved on this device only.</p>
</div></footer>
</body>
</html>
`;
}

const files = {};
const website = { '@type': 'WebSite', '@id': SITE_URL + '#website', name: SITE_NAME, url: SITE_URL, inLanguage: 'en' };
const pgUrl = SITE_URL + 'postgres/';

// ---------- homepage ----------
files['index.html'] = layout({
  path: '', root: './', page: 'site',
  title: `${SITE_NAME}: software internals, drawn open`,
  description: 'Interactive, step-by-step visual guides to how software works inside. Starting with Postgres: pages, MVCC, B-tree indexes, VACUUM, HOT updates, TOAST and shared buffers.',
  body: `<main class="home" id="site"><span id="content"></span>${siteHtml(EMPTY, './')}</main>`,
  ld: [{ ...website, description: 'Interactive, step-by-step visual guides to how software works inside.' }],
});

// ---------- Postgres contents ----------
files['postgres/index.html'] = layout({
  path: 'postgres/', root: '../', page: 'postgres', crumb: true,
  title: `Postgres internals, visualised: ${TOURS.length} interactive tours | ${SITE_NAME}`,
  description: `${TOURS.length} short, interactive tours of Postgres internals: pages, ctid, MVCC, snapshots, isolation levels, row locks, VACUUM, B-tree indexes, HOT updates, TOAST and shared buffers.`,
  body: `<main class="home" id="home"><span id="content"></span>${homeHtml(EMPTY, '../')}</main>`,
  ld: [website, {
    '@type': 'CollectionPage', '@id': pgUrl, url: pgUrl, name: 'Postgres internals, visualised', isPartOf: { '@id': website['@id'] },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: TOURS.length,
      itemListElement: TOURS.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: `${pgUrl}${t.slug}/` })),
    },
  }, crumbsLd([[SITE_NAME, SITE_URL], ['Postgres', pgUrl]])],
});

// ---------- one page per tour ----------
TOURS.forEach((t, i) => {
  const url = `${pgUrl}${t.slug}/`, root = '../../';
  files[`postgres/${t.slug}/index.html`] = layout({
    path: `postgres/${t.slug}/`, root, page: 'tour', tourId: t.id, crumb: true, contents: true, engine: true, ogType: 'article',
    title: `${t.title} in Postgres, explained step by step | ${SITE_NAME}`,
    description: clip(`${t.blurb} ${t.intro}`),
    body: `<main id="content">
<div class="app" id="app">
  <nav class="toc" id="toc" aria-label="Tours">${tocHtml(EMPTY, i, root)}</nav>
  <section class="story" id="story" aria-live="polite">${storyHtml(EMPTY, i, 0)}</section>
  <section class="stage" id="stage" aria-label="Simulated Postgres"><noscript><p class="empty-msg">The interactive drawing needs JavaScript. The whole tour is written out below.</p></noscript></section>
</div>
<article class="walk" aria-labelledby="walk-h">${walkHtml(i, root)}</article>
</main>
<div class="mobile-nav" id="mnav"></div>`,
    ld: [website, {
      '@type': 'LearningResource', '@id': url, url, name: `${t.title} in Postgres`, headline: `${t.title}: ${t.blurb}`,
      description: plain(t.intro), abstract: t.blurb, inLanguage: 'en',
      learningResourceType: 'Interactive tutorial', interactivityType: 'active', educationalLevel: 'Intermediate',
      isAccessibleForFree: true, timeRequired: `PT${tourMinutes(t)}M`, keywords: ['Postgres', 'PostgreSQL', t.group, ...t.tags].join(', '),
      teaches: t.tags, about: { '@type': 'SoftwareApplication', name: 'PostgreSQL', applicationCategory: 'DatabaseApplication' },
      isPartOf: { '@type': 'CollectionPage', '@id': pgUrl, name: 'Postgres internals, visualised' },
      position: i + 1, dateModified: TODAY,
    }, crumbsLd([[SITE_NAME, SITE_URL], ['Postgres', pgUrl], [t.title, url]])],
  });
});

// ---------- 404, robots, sitemap ----------
const base = new URL(SITE_URL).pathname; // GitHub Pages serves 404.html at any depth, so use absolute paths
files['404.html'] = `<!doctype html>
<html lang="en" data-skin="blueprint">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found | ${SITE_NAME}</title>
<meta name="robots" content="noindex">
<link rel="icon" href="${base}assets/favicon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,400..800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0E2A46;background-image:linear-gradient(rgba(207,227,245,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(207,227,245,.055) 1px,transparent 1px);background-size:24px 24px;color:#F5F9FD;font-family:Archivo,"Helvetica Neue",sans-serif;padding:24px;box-sizing:border-box}
main{max-width:520px}
p.k{font-family:"JetBrains Mono",monospace;color:#FFB061;margin:0 0 10px}
h1{font-size:3rem;line-height:1;margin:0 0 16px;font-stretch:78%;font-weight:800}
p{font-size:1.1rem;line-height:1.6;color:#C5D8EB;margin:0 0 24px}
a{display:inline-block;background:#FFB061;color:#0B233C;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:2px;margin:0 8px 8px 0}
a.alt{background:none;color:#F5F9FD;box-shadow:inset 0 0 0 1px #C5D8EB}
</style>
</head>
<body><main>
<p class="k">404: no tuple at this ctid</p>
<h1>This page doesn't exist.</h1>
<p>The address may have changed, or there's a typo in the link.</p>
<a href="${base}">Go to the homepage</a><a class="alt" href="${base}postgres/">All Postgres tours</a>
</main></body>
</html>
`;
files['robots.txt'] = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
const urls = [['', '1.0'], ['postgres/', '0.9'], ...TOURS.map(t => [`postgres/${t.slug}/`, '0.8'])];
files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, pr]) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${TODAY}</lastmod><priority>${pr}</priority></url>`).join('\n')}
</urlset>
`;

// Remove tour folders left behind by a renamed slug, then write everything.
const pgDir = join(DIR, 'postgres');
if (existsSync(pgDir)) rmSync(pgDir, { recursive: true });
for (const [rel, content] of Object.entries(files)) {
  const out = join(DIR, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
}
console.log(`Wrote ${Object.keys(files).length} files for ${SITE_URL}`);
