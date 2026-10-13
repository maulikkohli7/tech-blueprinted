// ===== Tech, Blueprinted: guided series UI =====
// Every page is a static file: the homepage, the Postgres contents page, and one page per tour.
// <body data-page="site|postgres|tour" data-tour="<tour id>" data-root="<path to site root>">
const PAGE = document.body.dataset.page;
const ROOT = document.body.dataset.root || './';
const db = PAGE === 'tour' ? new MiniPG(8) : null;
const PANELS = [['txn', 'Transactions'], ['index', 'B-tree indexes'], ['buffers', 'Shared buffers'], ['trace', 'Execution details']];
let overrides = {}; // panel -> true/false set by the reader, applies to every tour
try { overrides = JSON.parse(sessionStorage.getItem('ip-panels') || '{}') || {}; } catch (e) { }
let showBuf = true;
let cur = { ti: Math.max(0, TOURS.findIndex(t => t.id === document.body.dataset.tour)), k: 0 };
let last = null;
try { last = JSON.parse(localStorage.getItem('ip-last') || 'null'); } catch (e) { }
let done = new Set();
try { done = new Set(JSON.parse(localStorage.getItem('ip-done') || '[]')); } catch (e) { }
const progress = () => ({ done, last });
const $ = s => document.querySelector(s);
const STATE_LABEL = { live: 'live', dead: 'dead', uncommitted: 'not committed yet', locked: 'being changed', aborted: 'aborted' };
const TOUCH_LABEL = { vis: 'read', invis: 'skipped: not visible', skip: 'read, filtered out', new: 'written', del: 'xmax set', keep: 'kept by VACUUM' };
const BTAG = { hit: 'hit', read: 'read in', new: 'new block', flushed: 'written out' };

const tour = () => TOURS[cur.ti];
const lvl = () => cur.ti; // features appear as the series teaches them
const L = { hdr: 2, hints: 3, vm: 10, hot: 11 };
function panelOn(p) {
  if (overrides[p] != null) return overrides[p];
  if (p === 'toast') return !!tour().panels.toast || db.toast.pages.length > 0;
  return !!tour().panels[p];
}
function saveOverrides() { try { sessionStorage.setItem('ip-panels', JSON.stringify(overrides)); } catch (e) { } }

// ---------- navigation ----------
function goTo(ti, k, opts = {}) {
  if (ti !== cur.ti) { location.href = tourHref(ROOT, ti, k); return; } // another tour lives on its own page
  const t = TOURS[ti];
  k = Math.max(0, Math.min(k, t.steps.length));
  db.sessions.A.iso = 'READ COMMITTED'; db.sessions.B.iso = 'READ COMMITTED';
  db.nBuffers = t.buffers || 8;
  db.reset(true);
  for (let j = 0; j < k; j++) { const st = t.steps[j]; if (st.sql) db.run(st.s || 'A', st.sql); }
  if (k === 0) db.trace = null;
  if (k === 0 || !t.steps[k - 1].sql) db.clearTouch();
  cur = { ti, k };
  last = { ti, k }; try { localStorage.setItem('ip-last', JSON.stringify(last)); } catch (e) { }
  if (k === t.steps.length) { done.add(t.id); try { localStorage.setItem('ip-done', JSON.stringify([...done])); } catch (e) { } }
  if (window.gtag && opts.track !== false) gtag('event', k === t.steps.length ? 'tour_complete' : 'tour_step', { tour_id: t.id, step: k });
  try { history.replaceState(null, '', k ? `#${k}` : location.pathname + location.search); } catch (e) { }
  render();
  if (opts.top) window.scrollTo({ top: 0 });
}
const showHome = () => { location.href = ROOT + 'postgres/'; };
const next = () => { const t = tour(); if (cur.k < t.steps.length) goTo(cur.ti, cur.k + 1); else if (cur.ti < TOURS.length - 1) goTo(cur.ti + 1, 0, { top: true }); else showHome(); };
const back = () => { if (cur.k > 0) goTo(cur.ti, cur.k - 1); else if (cur.ti > 0) goTo(cur.ti - 1, TOURS[cur.ti - 1].steps.length, { top: true }); };

// ---------- header toggles ----------
function renderToggles() {
  const any = Object.values(overrides).some(v => v != null);
  $('#toggles').innerHTML = `<span class="lbl">Show</span>${PANELS.map(([p, name]) => `<button class="tog" data-p="${p}" aria-pressed="${panelOn(p)}">${name}</button>`).join('')}${any ? '<button class="tog-reset" id="togreset">Use each tour\'s defaults</button>' : ''}`;
  document.querySelectorAll('.tog').forEach(b => b.onclick = () => { overrides[b.dataset.p] = !panelOn(b.dataset.p); saveOverrides(); render(); });
  if (any) $('#togreset').onclick = () => { overrides = {}; saveOverrides(); render(); };
}

// ---------- story ----------
function renderStory() {
  $('#story').innerHTML = storyHtml(progress(), cur.ti, cur.k);
  $('#mnav').innerHTML = storyNav(cur.ti, cur.k).replace(/id="b-/g, 'id="m-');
  const wire = (pre) => { const b = $(`#${pre}-back`), f = $(`#${pre}-next`); if (b) b.onclick = back; if (f) f.onclick = next; };
  wire('b'); wire('m');
  $('#tsel').onchange = e => goTo(+e.target.value, 0, { top: true });
  $('#story').querySelectorAll('.dots button').forEach(b => b.onclick = () => goTo(cur.ti, +b.dataset.k));
}

// ---------- results ----------
function sessionCard(name, active) {
  const s = db.sessions[name], t = tour();
  let lastCmd = -1; s.log.forEach((e, i) => { if (e.type === 'cmd') lastCmd = i; });
  const earlier = s.log.slice(0, Math.max(0, lastCmd)).filter(e => e.type === 'cmd').slice(-3);
  const latest = lastCmd >= 0 ? s.log.slice(lastCmd) : [];
  const pill = s.failed ? '<span class="pill fail">failed, needs ROLLBACK</span>' : s.inTx ? `<span class="pill tx">in transaction${s.xid ? ' ' + s.xid : ''}${s.txIso === 'REPEATABLE READ' ? ', repeatable read' : ''}</span>` : '';
  const snap = s.inTx && s.snapshot ? `snapshot ${db.snapStr(s.snapshot)}` : (active && s.lastSnapshot && db.trace && db.trace.stats ? `used snapshot ${db.snapStr(s.lastSnapshot)}` : '');
  let out = '';
  for (const e of latest.slice(1)) {
    if (e.type === 'rows') out += `<table><thead><tr>${e.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${e.rows.map(r => `<tr>${r.map(v => `<td>${v == null ? '<span style="color:var(--muted)">null</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table><div class="ok">(${e.rows.length} row${e.rows.length === 1 ? '' : 's'})</div>`;
    else if (e.type === 'ok' || e.type === 'plan') out += `<div class="ok">${esc(e.text)}</div>`;
    else out += `<div class="${e.type}">${esc(e.text)}</div>${e.hint ? `<div class="hint">${esc(e.hint)}</div>` : ''}`;
  }
  const tr = db.trace, showPlan = active && tr && tr.stats && tr.plan;
  const plan = showPlan ? `<div class="rplan"><span class="plan">${esc(tr.plan.replace(/\s+\[.*\]$/, '').replace(/^(Update|Delete) on accounts → /, ''))}</span><span>${tr.stats.heapPages} heap page${tr.stats.heapPages === 1 ? '' : 's'}</span>${tr.stats.indexPages ? `<span>${tr.stats.indexPages} index page${tr.stats.indexPages === 1 ? '' : 's'}</span><span>${tr.stats.entriesRead} index entr${tr.stats.entriesRead === 1 ? 'y' : 'ies'} read</span>` : ''}<span>${tr.stats.tuplesChecked} tuple${tr.stats.tuplesChecked === 1 ? '' : 's'} checked</span>${db.lastPlan && db.lastPlan.ios ? `<span>Heap Fetches: ${tr.stats.heapFetches}</span>` : ''}${tr.stats.toastPages ? `<span>${tr.stats.toastPages} TOAST page${tr.stats.toastPages === 1 ? '' : 's'}</span>` : ''}</div>` : '';
  return `<div class="rcard ${active ? 'active' : ''}"><div class="rhead"><b>${t.sessions === 2 ? 'Session ' + name : 'Result'}</b>${pill}<span class="snap">${snap}</span></div>
    ${earlier.length ? `<div class="earlier">${earlier.map(e => `<div>${esc(e.text)};</div>`).join('')}</div>` : ''}
    ${latest.length ? `<div class="rcmd">${esc(latest[0].text)};</div><div class="rout">${out}</div>${plan}` : `<div class="rempty">${t.sessions === 2 ? 'Nothing run here yet.' : 'Results appear here as you step through.'}</div>`}</div>`;
}

// ---------- heap & toast pages ----------
function notesLine(t) {
  const tv = t.toast;
  if (!tv || tv.mode === 'null') return '';
  if (tv.mode === 'inline') return `<div class="notes">notes ${esc(fmtVal(t.data.notes))}, stored in the row</div>`;
  if (tv.mode === 'compressed') return `<div class="notes">notes compressed in the row: ${tv.raw} B → ${tv.comp} B</div>`;
  return `<div class="notes">notes → TOAST pointer: chunk_id ${tv.chunkId}, ${tv.nChunks} chunks, ${tv.payload} B</div>`;
}

function renderRel(rel, isToast) {
  const showHdr = isToast || lvl() >= L.hdr, showHints = lvl() >= L.hints, showHot = lvl() >= L.hot, showVm = lvl() >= L.vm, showSize = tour().id === 'toast';
  const capIns = isToast ? PAGE_CAP : db.insertCap();
  return rel.pages.map(pg => {
    const used = pg.lps.filter(l => l.state === 'normal').length;
    const room = !!db.pageSlot(pg), insRoom = !!db.pageSlot(pg, capIns);
    const freeLbl = room ? (insRoom ? 'free' : 'reserved') : '';
    const bar = `<div class="slotbar" aria-hidden="true"><div class="sb-hdr">hdr</div>${pg.lps.map((l, i) => `<div class="sb-lp ${l.state === 'normal' ? '' : l.state}">${i + 1}</div>`).join('')}<div class="sb-free ${freeLbl === 'reserved' ? 'reserved' : ''}">${freeLbl}</div>${pg.lps.map((l, i) => ({ l, i })).filter(x => x.l.state === 'normal').reverse().map(x => `<div class="sb-t ${db.tupleState(x.l.tuple)}">t${x.i + 1}</div>`).join('')}</div>`;
    const rows = pg.lps.map((lp, i) => {
      const tid = { p: pg.id, lp: i + 1 }, key = tkey(rel.name, tid);
      if (lp.state === 'unused') return `<div class="lprow unused"><div class="lpn">lp ${i + 1}</div><div class="lpbox">unused: free for the next row on this page</div></div>`;
      if (lp.state === 'redirect') return `<div class="lprow redirect"><div class="lpn">lp ${i + 1}</div><div class="lpbox redirect">redirect → lp ${lp.to}. The row that was here is gone; this slot forwards to its newer version because an index still points here.</div></div>`;
      if (lp.state === 'dead') return `<div class="lprow dead"><div class="lpn">lp ${i + 1}</div><div class="lpbox dead">dead: the row was removed and its space freed, but an index still points at this slot, so it waits for VACUUM.</div></div>`;
      const t = lp.tuple, st = db.tupleState(t), tc = db.touched[key];
      const hint = (c, a) => !showHints ? '' : (t.hints[c] ? '<span class="hint" title="hint bit: committed">c</span>' : '') + (t.hints[a] ? '<span class="hint" title="hint bit: aborted">a</span>' : '');
      const fwd = (t.ctid.p !== tid.p || t.ctid.lp !== tid.lp) ? `→ ${tidStr(t.ctid)}` : tidStr(t.ctid);
      const hotU = t.hotUpdated && t.xmax && db.status(t.xmax) !== 'aborted';
      const badges = isToast || !showHot ? '' : [hotU ? '<span class="badge">HOT updated</span>' : '', t.heapOnly ? '<span class="badge solid">heap-only</span>' : ''].join('');
      const data = isToast ? `chunk_id=${t.data.chunk_id} seq=${t.data.chunk_seq} ${t.data.size} B` : `id=${esc(t.data.id)} name=${esc(fmtVal(t.data.name))} balance=${esc(t.data.balance)}`;
      return `<div class="lprow"><div class="lpn">lp ${i + 1}</div>
        <div class="tuple ${st}${tc ? ' touch' : ''}" data-tid="${key}">
          ${tc && TOUCH_LABEL[tc] ? `<span class="touch-tag">${TOUCH_LABEL[tc]}</span>` : ''}
          <div class="t1"><span class="tid">${tidStr(tid)}</span><span class="state">${STATE_LABEL[st]}${showSize && !isToast ? ` <span class="size">${db.tupleSize(t)} B</span>` : ''}</span></div>
          ${showHdr ? `<div class="hdrs"><span>xmin <b>${t.xmin}</b>${hint('xminC', 'xminA')}</span><span>xmax <b>${t.xmax}</b>${t.xmax ? hint('xmaxC', 'xmaxA') : ''}</span>${isToast ? '' : `<span>t_ctid <b>${fwd}</b></span>`}</div>` : ''}
          <div class="data">${data}</div>
          ${isToast ? '' : notesLine(t)}
          ${badges ? `<div class="badges">${badges}</div>` : ''}
        </div></div>`;
    }).join('');
    const head = `<b>Page ${pg.id}</b>${!isToast && showVm && pg.allVisible ? '<span class="vm-badge" title="Visibility map bit set: every row on this page is visible to every transaction">all-visible</span>' : ''}<span>${used}/${PAGE_CAP} tuples${!isToast && db.fillfactor < 100 ? ` <span class="ff-note">(fillfactor ${db.fillfactor}: inserts stop at ${capIns})</span>` : ''}</span>`;
    return `<div class="page"><div class="page-head">${head}</div>${bar}<div class="slotcap"><span>line pointers →</span><span>← tuples</span></div><div class="lps">${rows}</div></div>`;
  }).join('');
}

// ---------- other panels ----------
function entryState(e) {
  const lp = db.getLp(db.heap, e.tid);
  if (!lp || lp.state === 'unused' || lp.state === 'dead') return 'dead';
  if (lp.state === 'redirect') return 'live';
  const pg = db.heap.pages[e.tid.p], ch = db.chainFrom(pg, e.tid.lp, false);
  return db.tupleState(pg.lps[ch[ch.length - 1] - 1].tuple);
}
function indexHtml() {
  const list = Object.values(db.indexes);
  if (!list.length) return '<p class="empty-msg">No index on this table yet.</p>';
  const ks = k => k.length > 1 ? '(' + k.map(fmtVal).join(', ') + ')' : fmtVal(k[0]);
  return list.map(idx => {
    const leaves = db.indexLeaves(idx), seps = leaves.slice(1).map(l => l[0] ? ks(l[0].key) : '');
    return `<div class="btree"><div class="btree-name">${esc(idx.name)}: B-tree on (${idx.cols.join(', ')})${(idx.include || []).length ? ` INCLUDE (${idx.include.join(', ')})` : ''}</div>
      <div class="root"><div class="node"><div class="nh">root page</div><div class="nb">${seps.length ? seps.map(s => `<span>${esc(s)}</span>`).join('<span style="color:var(--muted)">|</span>') : '<span style="color:var(--muted)">one leaf</span>'}</div></div></div>
      <div class="leaves">${leaves.map((leaf, li) => `<div class="node leaf"><div class="nh">leaf ${li + 1}</div><div class="nb">${leaf.length ? leaf.map(e => { const h = db.touchedIdx[idx.name + '|' + tidKey(e.tid)]; return `<span class="ie ${entryState(e)}${h === 'hit' ? ' hit' : h === 'read' ? ' rd' : ''}">${esc(ks(e.key))}${e.inc && Object.keys(e.inc).length ? ` <span class="inc">${Object.entries(e.inc).map(([k, v]) => esc(k + ' ' + fmtVal(v))).join(', ')}</span>` : ''} → ${tidStr(e.tid)}</span>`; }).join('') : '<span style="color:var(--muted)">empty</span>'}</div></div>`).join('')}</div></div>`;
  }).join('');
}
function txnHtml() {
  const x = Object.keys(db.clog).map(Number).sort((a, b) => a - b);
  const names = tour().sessions === 2 ? ['A', 'B'] : ['A'];
  return `<div class="shm-row" style="margin-top:0">
    <div><h3 class="mini">Commit log (pg_xact) <span class="mini-sub">status of every transaction ID</span></h3><div class="xlist">${x.map(id => { const s = db.clog[id]; return `<span class="xchip ${s === 'in progress' ? 'inprog' : s}">${id} ${s}</span>`; }).join('')}</div>
      <p class="empty-msg" style="margin:8px 0 0;font-size:.8rem">Next transaction ID: <b class="mono">${db.nextXid}</b></p></div>
    <div><h3 class="mini">Running transactions <span class="mini-sub">(the ProcArray; snapshots are built from it)</span></h3>
      <table class="proc"><thead><tr><th>${names.length > 1 ? 'session' : ''}</th><th>xid</th><th>snapshot</th><th>state</th></tr></thead><tbody>${names.map(n => { const s = db.sessions[n]; return `<tr><td>${names.length > 1 ? n : ''}</td><td>${s.xid ?? '—'}</td><td>${s.inTx && s.snapshot ? db.snapStr(s.snapshot) : '—'}</td><td style="font-family:var(--sans)">${s.failed ? 'failed' : s.inTx ? 'in transaction' : 'idle'}</td></tr>`; }).join('')}</tbody></table>
      <p class="empty-msg" style="margin:8px 0 0;font-size:.8rem">Snapshot format: <span class="mono">xmin:xmax:running</span>. IDs below xmin had finished, IDs from xmax on hadn't started, and the listed ones were still running. VACUUM can remove rows deleted before <b class="mono">${db.horizon()}</b>.</p></div></div>`;
}
function buffersHtml() {
  const bufs = db.buffers.map((b, i) => {
    const hand = i === db.hand ? '<span class="hand">clock hand</span>' : '', tch = db.touchedBuf[i];
    const tag = tch && BTAG[tch] ? `<span class="btag ${tch}">${BTAG[tch]}</span>` : '';
    if (!b) return `<div class="bcell free"><div class="bh"><span>buffer ${i}</span></div><div class="bb">free</div>${hand}${tag}</div>`;
    return `<div class="bcell${b.dirty ? ' dirtyb' : ''}"><div class="bh"><span>buffer ${i}</span>${b.dirty ? '<span class="dirty">dirty</span>' : '<span>clean</span>'}</div><div class="bb"><div class="tag">${esc(b.rel)}</div><div class="meta"><span>block ${b.blk}</span><span class="pips" title="usage count ${b.usage} of 5">${[1, 2, 3, 4, 5].map(n => `<i class="${n <= b.usage ? 'on' : ''}"></i>`).join('')}</span></div></div>${hand}${tag}</div>`;
  }).join('');
  const cached = {}; db.buffers.forEach(b => { if (b) cached[b.key] = b.dirty ? 'dirty' : 'cached'; });
  const disk = db.diskBlocks().map(r => `<div class="diskrow"><span class="rn">${esc(r.rel)}</span><div class="blocks">${Array.from({ length: r.n }, (_, i) => `<span class="blk ${cached[r.rel + '/' + i] || ''}">${i}</span>`).join('')}</div></div>`).join('');
  const b = db.trace && db.trace.buffers;
  return `<div class="shm-box"><span class="lbl">shared memory</span><div class="bufgrid">${bufs}</div></div>
    ${b ? `<div class="bufline">Last step: shared hit=${b.hit} read=${b.read} dirtied=${b.dirtied} written=${b.written}${b.extended ? ` <span>extended=${b.extended}</span>` : ''} <span>(the counters EXPLAIN (ANALYZE, BUFFERS) shows)</span></div>` : ''}
    <div class="disk"><h3 class="mini">Disk <span class="mini-sub">one file per table or index</span></h3>${disk}
      <div class="disk-legend"><span><i style="border-color:var(--line);background:var(--panel2)"></i>on disk only</span><span><i style="border-color:var(--accent);background:var(--accent-soft)"></i>in memory, same as disk</span><span><i style="border-color:var(--amber);background:var(--amber-soft)"></i>in memory and changed; disk copy is stale</span></div></div>`;
}
function traceHtml() {
  const tr = db.trace;
  if (!tr || !tr.session) return '<p class="empty-msg">Step forward to see every action Postgres takes for a statement.</p>';
  return `<div class="trace-tools" style="padding:0 0 8px"><span class="trace-plan" style="margin:0">${esc(tr.plan)}</span><label><input type="checkbox" id="showbuf" ${showBuf ? 'checked' : ''}> include shared-buffer activity</label></div>
    <ul class="steps${showBuf ? '' : ' nobuf'}">${tr.steps.map(s => `<li class="${s.head ? 'head' : ''} ${s.sub ? 'sub' : ''} ${s.buf ? 'buf' : ''} ${s.verdict ? 'v-' + s.verdict : ''}" ${s.tid ? `data-tid="${tkey(s.rel || TABLE, s.tid)}"` : ''}>${esc(s.text)}</li>`).join('')}</ul>`;
}

function panel(id, title, sub, body) { return `<section class="panel" id="panel-${id}"><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}<div class="panel-body">${body}</div></section>`; }

function renderStage() {
  const t = tour(), two = t.sessions === 2;
  const lastS = cur.k > 0 ? (t.steps.slice(0, cur.k).reverse().find(s => s.sql) || {}).s || 'A' : null;
  let html = `<div class="results">${(two ? ['A', 'B'] : ['A']).map(n => sessionCard(n, lastS === n && cur.k > 0 && !!t.steps[cur.k - 1].sql)).join('')}</div>`;
  const heapFirst = t.first !== 'buffers';
  const bufHtml = panelOn('buffers') ? panel('buf', 'Shared buffers', 'Every page is read and changed here, in memory, never directly on disk.', buffersHtml()) : '';
  if (!heapFirst) html += bufHtml;
  html += panel('heap', 'Table: accounts', lvl() < L.hdr ? 'Each card is a page. Slots are numbered from 1; a row\'s address is (page, slot).' : '<i class="sw" style="background:var(--live)"></i>live <i class="sw" style="background:var(--dead)"></i>dead <i class="sw" style="background:var(--amber)"></i>written by a transaction that hasn\'t finished <i class="sw" style="background:var(--grey)"></i>aborted', `<div class="pages">${renderRel(db.heap, false)}</div>`);
  if (panelOn('txn')) html += panel('txn', 'Transactions', '', txnHtml());
  if (panelOn('index')) html += panel('index', 'B-tree indexes', 'Each entry is a key and the ctid of a row, kept in sorted order. In the last step, dark entries led to a row and light ones were read but rejected. Struck-through entries lead to dead rows.', indexHtml());
  if (panelOn('toast')) html += panel('toast', 'TOAST table', 'Holds values too big to keep in the row, in chunks of up to about 2 KB.', db.toast.pages.length ? `<div class="pages">${renderRel(db.toast, true)}</div>` : '<p class="empty-msg">Empty so far.</p>');
  if (heapFirst) html += bufHtml;
  if (panelOn('trace')) html += panel('trace', 'Execution details', 'Everything Postgres did for the last statement.', traceHtml());
  $('#stage').innerHTML = html;
  const sb = $('#showbuf'); if (sb) sb.onchange = e => { showBuf = e.target.checked; renderStage(); };
  document.querySelectorAll('#panel-trace li[data-tid]').forEach(li => {
    li.onmouseenter = () => document.querySelectorAll(`.tuple[data-tid="${li.dataset.tid}"]`).forEach(x => x.classList.add('ping'));
    li.onmouseleave = () => document.querySelectorAll('.tuple.ping').forEach(x => x.classList.remove('ping'));
  });
  // focus highlight for the current step
  const st = cur.k > 0 ? t.steps[cur.k - 1] : null, f = st && st.focus;
  const sel = { slotbar: '.slotbar', lps: '.sb-lp, .lpn', tuples: '.sb-t, #panel-heap .tuple', ctid: '#panel-heap .tid', hdr: '#panel-heap .hdrs', txn: '#panel-txn', index: '#panel-index', vm: '.vm-badge', toast: '#panel-toast', buffers: '#panel-buf .bufgrid' }[f];
  if (sel) document.querySelectorAll(sel).forEach(el => el.classList.add('focus'));
}


function render() {
  renderToggles();
  $('#toc').innerHTML = tocHtml(progress(), cur.ti, ROOT);
  renderStory(); renderStage();
}

document.addEventListener('keydown', e => {
  if (PAGE !== 'tour') return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
});
document.documentElement.setAttribute('data-skin', 'blueprint');
(function start() {
  const h = location.hash || '';
  if (PAGE === 'tour') { const m = h.match(/^#(\d+)$/); goTo(cur.ti, m ? +m[1] : 0, { track: false }); return; }
  if (PAGE === 'site') {
    // Links from the old single-page site: #postgres, #contents and #<tour>/<step>
    const m = h.match(/^#([\w-]+)\/(\d+)$/), ti = m ? TOURS.findIndex(t => t.id === m[1]) : -1;
    if (ti >= 0) { location.replace(tourHref(ROOT, ti, +m[2])); return; }
    if (/^#(postgres|contents)$/.test(h)) { location.replace(ROOT + 'postgres/'); return; }
    $('#site').innerHTML = siteHtml(progress(), ROOT);
  }
  if (PAGE === 'postgres') $('#home').innerHTML = homeHtml(progress(), ROOT);
})();
