// ===== Page templates: shared by the browser and scripts/build.mjs =====
// Each function returns HTML for one part of a page. The build script calls them with an empty
// progress state to write static, crawlable pages; the browser calls them again with the reader's
// saved progress. `root` is the relative path from the current page to the site root.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtNote = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const tourHref = (root, i, k) => `${root}postgres/${TOURS[i].slug}/${k ? '#' + k : ''}`;
const tourMinutes = t => Math.max(2, Math.round(t.steps.length * 0.5));
const PG_TAGS = ['pages', 'MVCC', 'snapshots', 'B-tree indexes', 'VACUUM', 'HOT', 'TOAST', 'shared buffers'];

// Progress state: { done: Set of tour ids, last: { ti, k } | null }
function resumable(st) {
  const l = st.last;
  return !!(l && TOURS[l.ti] && !(l.ti === 0 && l.k === 0) && !(st.done.has(TOURS[l.ti].id) && l.k === TOURS[l.ti].steps.length));
}

const HERO_ART = `<div class="hero-art" aria-hidden="true">
      <div class="ha-head"><b>Page 0</b><span>accounts, 8 KB</span></div>
      <div class="ha-bar"><div class="sb-hdr" style="width:12%">hdr</div><div class="sb-lp" style="width:7%">1</div><div class="sb-lp" style="width:7%">2</div><div class="sb-lp" style="width:7%">3</div><div class="sb-free">free</div><div class="sb-t live" style="width:13%">t3</div><div class="sb-t dead" style="width:13%">t2</div><div class="sb-t live" style="width:13%">t1</div></div>
      <div class="ha-rows">
        <div class="ha-row"><div class="lpn">lp 1</div><div class="tuple live"><div class="t1"><span class="tid">(0,1)</span><span class="state">live</span></div><div class="hdrs"><span>xmin <b>100</b></span><span>xmax <b>0</b></span></div><div class="data">id=1 name='alice'</div></div></div>
        <div class="ha-row"><div class="lpn">lp 2</div><div class="tuple dead"><div class="t1"><span class="tid">(0,2)</span><span class="state">dead</span></div><div class="hdrs"><span>xmin <b>100</b></span><span>xmax <b>101</b></span><span>t_ctid <b>→ (0,3)</b></span></div><div class="data">id=2 name='bob' balance=200</div></div></div>
        <div class="ha-row"><div class="lpn">lp 3</div><div class="tuple live"><div class="t1"><span class="tid">(0,3)</span><span class="state">live</span></div><div class="hdrs"><span>xmin <b>101</b></span><span>xmax <b>0</b></span></div><div class="data">id=2 name='bob' balance=250</div></div></div>
      </div></div>`;

// ---------- homepage ----------
function siteHtml(st, root) {
  const nDone = TOURS.filter(t => st.done.has(t.id)).length, res = resumable(st);
  const pgSteps = TOURS.reduce((a, t) => a + t.steps.length, 0);
  return `
    <section class="site-hero">
      <div>
        <p class="kick">Software internals, drawn open</p>
        <h1>Every part labelled. Every step drawn.</h1>
        <p class="lede">Guided, step-by-step drawings of the systems you use every day. Each step runs a real command against a small simulation and shows exactly what changed inside. No setup, nothing to install.</p>
        <div class="cta">
          ${res ? `<a class="btn primary" href="${tourHref(root, st.last.ti, st.last.k)}">Continue: ${esc(TOURS[st.last.ti].title)}, step ${st.last.k}</a>` : `<a class="btn primary" href="${root}postgres/">Start with Postgres</a>`}
          <a class="btn" href="#soon">See what's coming</a>
        </div>
      </div>
      ${HERO_ART}
    </section>
    <div class="sec-head"><h2>Systems</h2><span>One series per system. Each tour takes a few minutes.</span></div>
    <div class="plates">
      <a class="plate" href="${root}postgres/">
        <div class="pb">
          <div class="pt"><h3 class="ht"><b>Postgres</b></h3><span class="status live">available</span></div>
          <p class="pd">How a relational database stores rows, keeps transactions apart, finds data with B-trees, cleans up after itself and caches pages in memory.</p>
          <div class="ptags">${PG_TAGS.map(x => `<span>${x}</span>`).join('')}</div>
        </div>
        <div class="pf"><span>${TOURS.length} tours</span><span>${pgSteps} steps</span><span class="acc">${nDone ? `${nDone} done` : 'start here'}</span></div>
      </a>
      ${SOON.map(s => `<div class="plate soon"${s.name === 'Kafka' ? ' id="soon"' : ''}>
        <div class="pb">
          <div class="pt"><h3 class="ht"><b>${esc(s.name)}</b></h3><span class="status soon">coming soon</span></div>
          <p class="pd">${esc(s.blurb)}</p>
          <div class="ptags">${s.tags.map(x => `<span>${esc(x)}</span>`).join('')}</div>
        </div>
        <div class="pf"><span>in preparation</span></div>
      </div>`).join('')}
    </div>
    <div class="sec-head"><h2>How the tours work</h2></div>
    <div class="how">
      <div><h3 class="ht"><b>Step, don't read</b></h3><p>Press Next and a real command runs. The drawing updates to show exactly what moved, and a short note explains why.</p></div>
      <div><h3 class="ht"><b>One idea per tour</b></h3><p>Each tour covers a single concept in a few minutes, in an order where every tour builds on the last.</p></div>
      <div><h3 class="ht"><b>Nothing to install</b></h3><p>It all runs in your browser. Your progress is saved on this device.</p></div>
    </div>`;
}

// ---------- Postgres contents page ----------
function homeHtml(st, root) {
  const nDone = TOURS.filter(t => st.done.has(t.id)).length, res = resumable(st), last = st.last;
  const firstTodo = TOURS.findIndex(t => !st.done.has(t.id));
  const groups = [...new Set(TOURS.map(t => t.group))];
  return `
    <nav class="back-link-wrap" aria-label="Breadcrumb"><a class="back-link" href="${root}">← All systems</a></nav>
    <section class="hero">
      <div>
        <h1>See what Postgres does with your rows</h1>
        <p>${TOURS.length} short, guided tours through pages, MVCC, indexes, VACUUM and memory. Each step runs real SQL against a small simulated Postgres and shows exactly what changes inside it. No setup, nothing to type.</p>
        <div class="cta">
          ${res ? `<a class="btn primary" href="${tourHref(root, last.ti, last.k)}">Continue: ${esc(TOURS[last.ti].title)}, step ${last.k}</a><a class="btn" href="${tourHref(root, 0, 0)}">Start from tour 1</a>`
      : nDone && firstTodo >= 0 ? `<a class="btn primary" href="${tourHref(root, firstTodo, 0)}">Next up: ${esc(TOURS[firstTodo].title)}</a>`
        : `<a class="btn primary" href="${tourHref(root, 0, 0)}">Start with tour 1: ${esc(TOURS[0].title)}</a>`}
        </div>
        ${nDone ? `<div class="progress-line"><span class="pbar"><i style="width:${Math.round(100 * nDone / TOURS.length)}%"></i></span>${nDone} of ${TOURS.length} tours done</div>` : ''}
      </div>
      ${HERO_ART}
    </section>
    ${groups.map(g => `<section class="module"><div><h2>${esc(g)}</h2><p>${esc(GROUPS[g] || '')}</p></div>
      <div class="cards">${TOURS.map((t, i) => ({ t, i })).filter(x => x.t.group === g).map(({ t, i }) => {
        const isDone = st.done.has(t.id), inProg = res && last.ti === i;
        return `
        <a class="card ${isDone ? 'done' : ''} ${inProg ? 'resume' : ''}" href="${tourHref(root, i, 0)}">
          <span class="ct"><span class="num">${isDone ? '✓' : i + 1}</span><b>${esc(t.title)}</b></span>
          <span class="cb">${esc(t.blurb)}</span>
          <span class="tags">${t.tags.map(x => `<span>${esc(x)}</span>`).join('')}</span>
          <span class="cm"><span>${t.steps.length} steps${t.sessions === 2 ? ', two sessions' : ''}</span><span>${inProg ? 'in progress' : isDone ? 'done' : `about ${tourMinutes(t)} min`}</span></span>
        </a>`;
      }).join('')}</div></section>`).join('')}`;
}

// ---------- tour page: table of contents ----------
function tocHtml(st, ti, root) {
  let html = '', g = null;
  TOURS.forEach((t, i) => {
    if (t.group !== g) { if (g) html += '</ol>'; g = t.group; html += `<h3>${esc(g)}</h3><ol>`; }
    const d = st.done.has(t.id);
    html += `<li class="${d ? 'done' : ''}"><a href="${tourHref(root, i, 0)}" aria-current="${i === ti}"><span class="num">${d ? '✓' : i + 1}</span>${esc(t.title)}</a></li>`;
  });
  return html + '</ol>';
}

// ---------- tour page: the story column ----------
function storyNav(ti, k) {
  const t = TOURS[ti], end = k === t.steps.length, nextT = TOURS[ti + 1];
  const nextLabel = k === 0 ? 'Start' : !end ? 'Next' : nextT ? `Next tour: ${nextT.title}` : 'Back to all tours';
  return `<button class="btn" id="b-back" ${ti === 0 && k === 0 ? 'disabled' : ''}>Back</button><button class="btn primary" id="b-next">${esc(nextLabel)}</button>`;
}
function storyHtml(st, ti, k) {
  const t = TOURS[ti], n = t.steps.length, step = k > 0 ? t.steps[k - 1] : null;
  const end = k === n, nextT = TOURS[ti + 1];
  const opts = TOURS.map((x, i) => `<option value="${i}" ${i === ti ? 'selected' : ''}>${i + 1}. ${esc(x.title)}${st.done.has(x.id) ? ' ✓' : ''}</option>`).join('');
  return `
    <select class="toc-select" id="tsel" aria-label="Choose a tour">${opts}</select>
    <p class="kicker">Tour ${ti + 1} of ${TOURS.length}, ${esc(t.group)}</p>
    <h1>${esc(t.title)}</h1>
    <div class="dots" aria-label="Steps">${Array.from({ length: n + 1 }, (_, i) => `<button aria-label="${i === 0 ? 'Introduction' : 'Step ' + i}" class="${i < k ? 'on' : ''} ${i === k ? 'cur' : ''}" data-k="${i}"></button>`).join('')}</div>
    ${k === 0 ? `<p class="prose">${fmtNote(t.intro)}</p>` : `
      ${step.sql ? `<div class="ran"><div class="who">${t.sessions === 2 ? `Session ${step.s || 'A'} ran` : 'Ran'}</div><pre>${esc(step.sql)};</pre></div>` : ''}
      <p class="prose">${fmtNote(step.note)}</p>
      ${end ? `<p class="prose" style="color:var(--muted)">${nextT ? 'End of this tour.' : 'That\'s the whole series. Revisit any tour from the list.'}</p>` : ''}`}
    <div class="nav">${storyNav(ti, k)}<span class="keys">← → keys work too</span></div>`;
}

// ---------- tour page: the whole tour as text (for readers without JavaScript, and for search engines) ----------
function walkHtml(ti, root) {
  const t = TOURS[ti], prev = TOURS[ti - 1], next = TOURS[ti + 1];
  return `
    <h2 id="walk-h">The whole tour, step by step</h2>
    <p class="prose">${fmtNote(t.intro)}</p>
    <ol class="walk-steps">${t.steps.map(s => `
      <li>${s.sql ? `<pre class="walk-sql"><code>${t.sessions === 2 ? `-- session ${s.s || 'A'}\n` : ''}${esc(s.sql)};</code></pre>` : ''}<p>${fmtNote(s.note)}</p></li>`).join('')}
    </ol>
    <nav class="pager" aria-label="More tours">
      ${prev ? `<a rel="prev" href="${tourHref(root, ti - 1, 0)}"><span>Previous tour</span><b>${esc(prev.title)}</b></a>` : `<a href="${root}postgres/"><span>Back to</span><b>All Postgres tours</b></a>`}
      ${next ? `<a rel="next" class="nx" href="${tourHref(root, ti + 1, 0)}"><span>Next tour</span><b>${esc(next.title)}</b></a>` : `<a class="nx" href="${root}postgres/"><span>You've reached the end</span><b>All Postgres tours</b></a>`}
    </nav>`;
}
