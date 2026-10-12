// ===== Mini Postgres engine (simulator) v2: HOT, shared buffers, TOAST =====
const COLS = ['id', 'name', 'balance', 'notes'];
const SYS_COLS = ['ctid', 'xmin', 'xmax'];
const TABLE = 'accounts';
const PAGE_CAP = 4;          // tuples per page in this lab
const MAX_LP = 8;            // line pointers per page in this lab
const TOAST_THRESHOLD = 2032; // bytes, same as real Postgres with 8 KB pages
const CHUNK = 1996;           // TOAST_MAX_CHUNK_SIZE for 8 KB pages
const TOAST_REL = 'pg_toast_16384';
const TOAST_IDX = 'pg_toast_16384_index';

function tidStr(t) { return `(${t.p},${t.lp})`; }
function tidKey(t) { return t.p + ':' + t.lp; }
function tkey(rel, t) { return rel + '|' + t.p + ':' + t.lp; }

class Session {
  constructor(name) {
    this.name = name;
    this.inTx = false; this.xid = null; this.snapshot = null;
    this.iso = 'READ COMMITTED'; this.txIso = null;
    this.failed = false;
    this.enableIndexScan = true; this.enableSeqScan = true;
    this.log = []; this.history = [];
  }
}

class SimError extends Error { constructor(msg, opts = {}) { super(msg); this.fatal = opts.fatal !== false; this.hint = opts.hint; this.kind = opts.kind || 'error'; } }

class MiniPG {
  constructor(nBuffers = 8) { this.nBuffers = nBuffers; this.reset(true); }

  reset(seed = true) {
    _rng = 12345;
    this.fillfactor = 100;
    this.hasNotes = false;
    this.nextXid = 100;
    this.nextOid = 16400;
    this.clog = {};
    this.heap = { name: TABLE, pages: [] };
    this.toast = { name: TOAST_REL, pages: [] };
    this.indexes = {};
    const keepIso = this.sessions ? { A: this.sessions.A.iso, B: this.sessions.B.iso } : null;
    this.sessions = { A: new Session('A'), B: new Session('B') };
    if (keepIso) { this.sessions.A.iso = keepIso.A; this.sessions.B.iso = keepIso.B; }
    this.initBuffers(this.nBuffers);
    this.clearTouch();
    this.trace = null;
    if (seed) {
      this.quiet = true;
      const x = this.nextXid++;
      this.clog[x] = 'committed';
      [[1, 'alice', 100], [2, 'bob', 200], [3, 'carol', 300]].forEach(([id, name, balance]) => this.insertRow({ id, name, balance, notes: null }, x, null));
      this.heap.pages.forEach(pg => pg.lps.forEach(l => { l.tuple.hints.xminC = true; }));
      this.quiet = false;
      this.trace = { session: null, sql: 'seed', plan: 'Setup', steps: [{ text: `Transaction ${x} inserted 3 rows and committed. Everything is on disk and shared buffers are empty, as if the server just started. Run a statement to see its execution trace here.` }], stats: null };
    }
  }

  clearTouch() { this.pinned = -1; this.touched = {}; this.touchedIdx = {}; this.touchedBuf = {}; this.bufStats = { hit: 0, read: 0, dirtied: 0, written: 0, extended: 0 }; }

  // ---------- shared buffers ----------
  initBuffers(n) { this.nBuffers = n; this.buffers = Array(n).fill(null); this.hand = 0; }

  bufFind(key) { return this.buffers.findIndex(b => b && b.key === key); }

  bufAccess(rel, blk, steps, opts = {}) {
    if (this.quiet) return -1;
    const key = rel + '/' + blk, st = this.bufStats;
    let i = this.bufFind(key);
    if (i >= 0) {
      const b = this.buffers[i];
      b.usage = Math.min(5, b.usage + 1); st.hit++;
      if (!this.touchedBuf[i]) this.touchedBuf[i] = 'hit';
      if (steps) steps.push({ text: `shared buffers: hit on ${key} in buffer ${i} (usage count → ${b.usage})`, sub: true, buf: true });
    } else {
      i = this.bufVictim(steps);
      this.buffers[i] = { key, rel, blk, dirty: false, usage: 1 };
      if (opts.extend) { st.extended++; if (steps) steps.push({ text: `shared buffers: ${key} is a brand-new block (relation extended), placed in buffer ${i} without reading disk`, sub: true, buf: true }); }
      else { st.read++; if (steps) steps.push({ text: `shared buffers: miss on ${key} → read it from disk into buffer ${i}`, sub: true, buf: true }); }
      this.touchedBuf[i] = opts.extend ? 'new' : 'read';
    }
    this.pinned = i;
    if (opts.dirty) this.bufDirty(i, steps);
    return i;
  }

  bufDirty(i, steps) {
    const b = this.buffers[i];
    if (b && !b.dirty) { b.dirty = true; this.bufStats.dirtied++; if (steps) steps.push({ text: `shared buffers: ${b.key} is now dirty (changed in memory, disk copy is stale)`, sub: true, buf: true }); }
    if (b && this.touchedBuf[i] !== 'read') this.touchedBuf[i] = this.touchedBuf[i] || 'hit';
  }

  markDirtyKey(key, steps) { if (this.quiet) return; const i = this.bufFind(key); if (i >= 0) this.bufDirty(i, steps); }

  bufVictim(steps) {
    const free = this.buffers.findIndex(b => !b);
    if (free >= 0) return free;
    const swept = [];
    for (let guard = 0; guard < 10000; guard++) {
      const i = this.hand; this.hand = (this.hand + 1) % this.nBuffers;
      const b = this.buffers[i];
      if (i === this.pinned) continue; // pinned: the page this backend is still holding
      if (b.usage > 0) { b.usage--; swept.push(i); continue; }
      const pinNote = this.pinned >= 0 && this.buffers[this.pinned] ? `, skipping buffer ${this.pinned} because it is pinned (still in use)` : '';
      const sw = swept.length ? `clock hand lowered usage counts ${swept.length} time${swept.length > 1 ? 's' : ''} as it swept${pinNote}, then ` : `clock hand${pinNote} `;
      if (b.dirty) { this.bufStats.written++; if (steps) steps.push({ text: `shared buffers: no free buffer; ${sw}found buffer ${i} (${b.key}) at usage 0. It is dirty, so it must be written to disk before reuse.`, sub: true, buf: true, verdict: 'evict' }); }
      else if (steps) steps.push({ text: `shared buffers: no free buffer; ${sw}found buffer ${i} (${b.key}) at usage 0, clean, evicted`, sub: true, buf: true, verdict: 'evict' });
      this.buffers[i] = null;
      return i;
    }
  }

  checkpoint(steps) {
    let n = 0;
    this.buffers.forEach((b, i) => { if (b && b.dirty) { b.dirty = false; n++; this.bufStats.written++; this.touchedBuf[i] = 'flushed'; if (steps) steps.push({ text: `buffer ${i}: wrote ${b.key} to disk`, sub: true, verdict: 'ok' }); } });
    return n;
  }

  restart(n) {
    const steps = [];
    const flushed = this.checkpoint(null);
    const aborted = this.activeXids();
    aborted.forEach(x => this.clog[x] = 'aborted');
    Object.values(this.sessions).forEach(s => {
      const was = s.inTx;
      s.inTx = false; s.xid = null; s.snapshot = null; s.failed = false; s.txIso = null;
      s.log.push({ type: 'warn', text: `server restarted with shared_buffers = ${n}${was ? '; this session\'s open transaction was rolled back' : ''}` });
    });
    this.initBuffers(n);
    this.clearTouch();
    steps.push({ text: `shutdown checkpoint wrote ${flushed} dirty buffer${flushed === 1 ? '' : 's'} to disk` });
    if (aborted.length) steps.push({ text: `in-progress xid${aborted.length > 1 ? 's' : ''} ${aborted.join(', ')} marked aborted` });
    steps.push({ text: `shared memory re-created with ${n} empty buffers. The cache is cold again.` });
    this.trace = { session: null, sql: 'restart', plan: `Server restart (shared_buffers = ${n})`, steps, stats: null };
  }

  // ---------- transaction status ----------
  status(xid) { return this.clog[xid] || 'in progress'; }
  activeXids() { return Object.keys(this.clog).filter(x => this.clog[x] === 'in progress').map(Number); }
  takeSnapshot(sess) {
    const active = this.activeXids();
    return { xmin: Math.min(this.nextXid, ...active), xmax: this.nextXid, xip: active.filter(x => x !== sess.xid).sort((a, b) => a - b) };
  }
  snapStr(s) { return s ? `${s.xmin}:${s.xmax}:${s.xip.join(',')}` : '—'; }
  committedInSnap(xid, snap) { return this.status(xid) === 'committed' && xid < snap.xmax && !snap.xip.includes(xid); }
  horizon() {
    const snapXmins = Object.values(this.sessions).filter(s => s.inTx && s.snapshot).map(s => s.snapshot.xmin);
    return Math.min(this.nextXid, ...this.activeXids(), ...snapXmins);
  }
  deadToAll(t, h) {
    const xs = this.status(t.xmin);
    if (xs === 'aborted') return true;
    return xs === 'committed' && !!t.xmax && this.status(t.xmax) === 'committed' && t.xmax < h;
  }

  xidStatusWithHints(t, which, steps, setHints) {
    const xid = t[which], h = t.hints;
    const C = which === 'xmin' ? 'xminC' : 'xmaxC', A = which === 'xmin' ? 'xminA' : 'xmaxA';
    if (h[C]) return 'committed';
    if (h[A]) return 'aborted';
    const st = this.status(xid);
    if (setHints && st !== 'in progress') {
      h[st === 'committed' ? C : A] = true;
      if (steps) steps.push({ text: `  looked up xid ${xid} in pg_xact → ${st}; set hint bit ${which.toUpperCase()}_${st === 'committed' ? 'COMMITTED' : 'INVALID'} on the tuple (a read just dirtied the page)`, sub: true });
      this.markDirtyKey(t.rel + '/' + t.pg, steps);
    }
    return st;
  }

  visibility(t, snap, sess, steps = null, setHints = true) {
    const me = sess ? sess.xid : null;
    const R = (visible, why) => ({ visible, why });
    if (me != null && t.xmin === me) {
      if (t.xmax === me) return R(false, `inserted and then deleted/updated by my own transaction ${me}`);
      return R(true, `inserted by my own transaction ${me}`);
    }
    const xs = this.xidStatusWithHints(t, 'xmin', steps, setHints);
    if (xs === 'aborted') return R(false, `xmin ${t.xmin} aborted → this insert never happened`);
    if (!this.committedInSnap(t.xmin, snap)) return R(false, xs === 'in progress' ? `xmin ${t.xmin} is still in progress` : `xmin ${t.xmin} committed after my snapshot was taken`);
    if (!t.xmax) return R(true, `xmin ${t.xmin} committed before my snapshot, xmax empty`);
    if (me != null && t.xmax === me) return R(false, `deleted/updated by my own transaction ${me}`);
    const ys = this.xidStatusWithHints(t, 'xmax', steps, setHints);
    if (ys === 'aborted') return R(true, `xmin ${t.xmin} committed; xmax ${t.xmax} aborted → the delete never happened`);
    if (!this.committedInSnap(t.xmax, snap)) return R(true, `xmin ${t.xmin} committed; xmax ${t.xmax} ${ys === 'in progress' ? 'still in progress' : 'committed after my snapshot'} → I still see this version`);
    return R(false, `xmax ${t.xmax} committed before my snapshot → this version is dead to me`);
  }

  tupleState(t) {
    const xs = this.status(t.xmin);
    if (xs === 'aborted') return 'aborted';
    if (xs === 'in progress') return 'uncommitted';
    if (!t.xmax) return 'live';
    const ys = this.status(t.xmax);
    if (ys === 'aborted') return 'live';
    if (ys === 'in progress') return 'locked';
    return 'dead';
  }

  // ---------- page storage ----------
  insertCap() { return Math.max(1, Math.floor(PAGE_CAP * this.fillfactor / 100)); }
  pageSlot(pg, cap = PAGE_CAP) {
    const stored = pg.lps.filter(l => l.state === 'normal').length;
    if (stored >= cap) return null;
    const u = pg.lps.findIndex(l => l.state === 'unused');
    if (u >= 0) return { p: pg.id, lp: u + 1, reuse: true };
    if (pg.lps.length < MAX_LP) return { p: pg.id, lp: pg.lps.length + 1, reuse: false };
    return null;
  }

  findSlot(rel, prefer, onlyPrefer = false) {
    const cap = rel === this.heap ? this.insertCap() : PAGE_CAP;
    if (prefer != null && rel.pages[prefer]) { const s = this.pageSlot(rel.pages[prefer], cap); if (s || onlyPrefer) return s; }
    for (const pg of rel.pages) { const s = this.pageSlot(pg, cap); if (s) return s; }
    const pg = { id: rel.pages.length, lps: [], allVisible: false };
    rel.pages.push(pg);
    return { p: pg.id, lp: 1, reuse: false, newPage: true };
  }

  getLp(rel, tid) { const pg = rel.pages[tid.p]; return pg ? pg.lps[tid.lp - 1] : null; }
  getTuple(rel, tid) { const lp = this.getLp(rel, tid); return lp && lp.state === 'normal' ? lp.tuple : null; }

  placeTuple(rel, tuple, slot, steps, label) {
    const tid = { p: slot.p, lp: slot.lp };
    tuple.ctid = { ...tid }; tuple.rel = rel.name; tuple.pg = slot.p;
    const pg = rel.pages[slot.p];
    if (rel === this.heap) this.clearVM(slot.p, steps);
    if (slot.reuse) pg.lps[slot.lp - 1] = { state: 'normal', tuple };
    else pg.lps.push({ state: 'normal', tuple });
    this.bufAccess(rel.name, slot.p, steps, { dirty: true, extend: !!slot.newPage });
    if (steps && label) steps.push({ text: label(tid, slot), tid, rel: rel.name, verdict: 'new' });
    this.touched[tkey(rel.name, tid)] = 'new';
    return tid;
  }

  clearVM(p, steps) {
    const pg = this.heap.pages[p];
    if (pg && pg.allVisible) { pg.allVisible = false; if (steps && !this.quiet) steps.push({ text: `visibility map: page ${p} is no longer all-visible (it was just changed)`, verdict: 'vm' }); }
  }

  // ---------- TOAST ----------
  tupleBase(d) { return 24 + 4 + (d.name == null ? 0 : varlena(d.name)) + 4; }
  tupleSize(t) { return this.tupleBase(t.data) + (t.toast ? t.toast.stored : 0); }

  toastValue(d, xid, steps) {
    const v = d.notes;
    if (v == null) return { mode: 'null', stored: 0 };
    const base = this.tupleBase(d), raw = v.length;
    if (base + varlena(v) <= TOAST_THRESHOLD) return { mode: 'inline', raw, stored: varlena(v) };
    const comp = estimateCompressed(v);
    if (steps) steps.push({ text: `TOAST: row would be ${base + varlena(v)} B, over the ${TOAST_THRESHOLD} B threshold → try compressing notes first`, head: true });
    if (comp != null && base + comp + 4 <= TOAST_THRESHOLD) {
      if (steps) steps.push({ text: `notes compresses ${raw} B → ${comp} B (pglz). Row now fits, so the compressed value stays inline. Nothing goes to ${TOAST_REL}.`, sub: true });
      return { mode: 'compressed', raw, comp, stored: comp + 4 };
    }
    const payload = comp != null ? comp : raw;
    if (steps) steps.push({ text: comp != null ? `compressed to ${comp} B, still too big → move it out of line` : `notes barely compresses (random data), so compression is skipped → move it out of line`, sub: true });
    const chunkId = this.nextOid++;
    const n = Math.ceil(payload / CHUNK);
    const tids = [];
    if (!this.quiet) this.bufAccess(TOAST_IDX, 0, steps, { dirty: true, extend: this.toast.pages.length === 0 });
    for (let s = 0; s < n; s++) {
      const size = Math.min(CHUNK, payload - s * CHUNK);
      const slot = this.findSlot(this.toast, null);
      const tuple = { xmin: xid, xmax: 0, data: { chunk_id: chunkId, chunk_seq: s, size }, hints: {} };
      tids.push(this.placeTuple(this.toast, tuple, slot, steps, tid => `${TOAST_REL} insert → ${tidStr(tid)}: chunk_id ${chunkId}, chunk_seq ${s}, ${size} B, xmin=${xid}`));
    }
    if (steps) steps.push({ text: `heap tuple keeps an 18-byte TOAST pointer (chunk_id ${chunkId}, ${n} chunk${n > 1 ? 's' : ''}) instead of the ${payload} B value`, sub: true });
    return { mode: 'external', raw, comp, payload, chunkId, nChunks: n, tids, stored: 18 };
  }

  toastDelete(toast, xid, steps, why) {
    if (!toast || toast.mode !== 'external') return;
    for (const tid of toast.tids) {
      const t = this.getTuple(this.toast, tid);
      if (!t) continue;
      t.xmax = xid; delete t.hints.xmaxC; delete t.hints.xmaxA;
      this.bufAccess(TOAST_REL, tid.p, steps, { dirty: true });
      this.touched[tkey(TOAST_REL, tid)] = 'del';
    }
    if (steps) steps.push({ text: `${TOAST_REL}: chunk_id ${toast.chunkId} (${toast.nChunks} chunk${toast.nChunks > 1 ? 's' : ''}) got xmax = ${xid}, ${why}. TOAST rows follow MVCC too.`, verdict: 'del' });
  }

  detoast(tid, t, steps, stats) {
    const tv = t.toast;
    if (!tv || tv.mode === 'null' || tv.mode === 'inline') return;
    if (tv.mode === 'compressed') { steps.push({ text: `${tidStr(tid)}.notes: decompress inline value ${tv.comp} B → ${tv.raw} B`, sub: true }); return; }
    steps.push({ text: `${tidStr(tid)}.notes is a TOAST pointer → look up chunk_id ${tv.chunkId} in ${TOAST_IDX}, fetch ${tv.nChunks} chunk${tv.nChunks > 1 ? 's' : ''}, reassemble ${tv.payload} B${tv.comp != null ? ', decompress to ' + tv.raw + ' B' : ''}`, verdict: 'toast' });
    this.bufAccess(TOAST_IDX, 0, steps);
    const pages = new Set();
    for (const ct of tv.tids) { pages.add(ct.p); this.touched[tkey(TOAST_REL, ct)] = 'vis'; }
    for (const p of pages) { this.bufAccess(TOAST_REL, p, steps); stats.toastPages++; }
  }

  // ---------- inserts ----------
  insertRow(data, xid, prefer, steps, opts = {}) {
    const toast = opts.toast || this.toastValue(data, xid, steps);
    const tuple = { xmin: xid, xmax: 0, data: { ...data }, hints: {}, toast, heapOnly: !!opts.heapOnly, hotUpdated: false };
    const slot = opts.slot || this.findSlot(this.heap, prefer);
    const tid = this.placeTuple(this.heap, tuple, slot, steps, (tid, s) => {
      let where = s.newPage ? `no page had room, so the table was extended with page ${s.p}` : s.reuse ? `reused free line pointer ${s.lp} on page ${s.p}` : `free space on page ${s.p}`;
      if (prefer != null && s.p !== prefer) where += ` (page ${prefer} had no room)`;
      return `heap insert → ctid ${tidStr(tid)} [${where}], xmin=${xid}, ${this.tupleSize(tuple)} B${opts.heapOnly ? ', heap-only tuple' : ''}`;
    });
    if (!opts.heapOnly) for (const idx of Object.values(this.indexes)) this.indexInsert(idx, idx.cols.map(c => data[c]), tid, steps, data);
    return { tid, tuple };
  }

  incOf(idx, data) { const o = {}; (idx.include || []).forEach(c => o[c] = data[c]); return o; }
  indexInsert(idx, key, tid, steps, data) {
    const before = this.indexLeaves(idx).length;
    idx.entries.push({ key, tid: { ...tid }, inc: data ? this.incOf(idx, data) : {} });
    this.sortIndex(idx);
    const pos = idx.entries.findIndex(e => e.tid.p === tid.p && e.tid.lp === tid.lp && cmpKey(e.key, key) === 0);
    const leaf = Math.floor(pos / 4) + 1, after = this.indexLeaves(idx).length;
    if (steps) steps.push({ text: `index ${idx.name}: insert ${key.length > 1 ? '(' + key.map(fmtVal).join(', ') + ')' : fmtVal(key[0])} → ${tidStr(tid)}${(idx.include || []).length ? ' (+ ' + idx.include.map(c => c + ' ' + fmtVal(data[c])).join(', ') + ')' : ''} into leaf L${leaf}${after > before ? ' (a new leaf page was needed)' : ''}`, sub: true });
    this.bufAccess(idx.name, 0, steps, { dirty: after > before });
    this.bufAccess(idx.name, leaf, steps, { dirty: true, extend: after > before && leaf === after });
  }

  sortIndex(idx) { idx.entries.sort((a, b) => cmpKey(a.key, b.key) || a.tid.p - b.tid.p || a.tid.lp - b.tid.lp); }
  indexLeaves(idx) {
    const leaves = [];
    for (let i = 0; i < idx.entries.length; i += 4) leaves.push(idx.entries.slice(i, i + 4));
    if (!leaves.length) leaves.push([]);
    return leaves;
  }

  // ---------- HOT chains & pruning ----------
  // follow a HOT chain starting at lp number `start` on page pg
  chainFrom(pg, start, requireHeapOnly) {
    const out = [];
    let cur = start, prevXmax = null, first = true;
    while (cur) {
      const l = pg.lps[cur - 1];
      if (!l || l.state !== 'normal') break;
      const t = l.tuple;
      if ((!first || requireHeapOnly) && !t.heapOnly) break;
      if (prevXmax != null && t.xmin !== prevXmax) break;
      out.push(cur);
      if (t.hotUpdated && t.xmax && this.status(t.xmax) !== 'aborted' && t.ctid.p === pg.id) { prevXmax = t.xmax; cur = t.ctid.lp; first = false; }
      else break;
    }
    return out;
  }

  prunePage(rel, pg, h, steps) {
    const lps = pg.lps, visited = new Set(), actions = [];
    const setLp = (n, v) => { lps[n - 1] = v; };
    lps.forEach((lp, i) => {
      const n = i + 1;
      const isRoot = lp.state === 'redirect' || (lp.state === 'normal' && !lp.tuple.heapOnly);
      if (!isRoot) return;
      const chain = lp.state === 'redirect' ? this.chainFrom(pg, lp.to, true) : this.chainFrom(pg, n, false);
      chain.forEach(c => visited.add(c));
      let k = 0; while (k < chain.length && this.deadToAll(lps[chain[k] - 1].tuple, h)) k++;
      if (k === 0 && !(lp.state === 'redirect' && chain.length === 0)) return;
      if (k === chain.length) {
        chain.forEach(c => { if (c !== n) { setLp(c, { state: 'unused' }); actions.push(`lp ${c} → unused (dead heap-only tuple, nothing points at it)`); } });
        setLp(n, { state: 'dead' });
        actions.push(`lp ${n} → dead (${lp.state === 'redirect' ? 'whole HOT chain dead' : chain.length > 1 ? 'whole HOT chain dead' : 'tuple dead to everyone'}); tuple space freed, but an index may still point here, so only VACUUM can mark it unused`);
      } else {
        const survivor = chain[k];
        chain.slice(0, k).forEach(c => { if (c !== n) { setLp(c, { state: 'unused' }); actions.push(`lp ${c} → unused (dead heap-only tuple)`); } });
        setLp(n, { state: 'redirect', to: survivor });
        actions.push(`lp ${n} → redirect to lp ${survivor} (index entries point at lp ${n}, so it must stay as a signpost to the live end of the HOT chain)`);
      }
    });
    lps.forEach((lp, i) => {
      if (lp.state === 'normal' && lp.tuple.heapOnly && !visited.has(i + 1) && this.deadToAll(lp.tuple, h)) {
        lps[i] = { state: 'unused' }; actions.push(`lp ${i + 1} → unused (orphaned heap-only tuple from an aborted update)`);
      }
    });
    if (steps) {
      if (actions.length) { steps.push({ text: `prune page ${pg.id} of ${rel.name} (horizon ${h}):`, verdict: 'removed' }); actions.forEach(a => steps.push({ text: '  ' + a, sub: true })); }
      else steps.push({ text: `prune page ${pg.id}: nothing is dead to every snapshot yet (horizon ${h})`, sub: true });
    }
    if (actions.length) this.markDirtyKey(rel.name + '/' + pg.id, steps);
    return actions.length;
  }

  // ---------- statement runner ----------
  run(sessName, sqlRaw) {
    const sess = this.sessions[sessName];
    const sql = sqlRaw.trim().replace(/;+\s*$/, '').trim();
    if (!sql) return;
    sess.history.push(sql);
    sess.log.push({ type: 'cmd', text: sql, prompt: sess.failed ? '!' : sess.inTx ? '*' : '' });
    this.clearTouch();
    const steps = [];
    this.trace = { session: sessName, sql, plan: '', steps, stats: null, buffers: null };
    try {
      const res = this.dispatch(sess, sql, steps);
      if (res) sess.log.push(res);
    } catch (e) {
      if (!(e instanceof SimError)) { console.error(e); e = new SimError('internal simulator error: ' + e.message); }
      if (e.kind === 'blocked') { sess.log.push({ type: 'warn', text: e.message, hint: e.hint }); steps.push({ text: e.message, verdict: 'blocked' }); }
      else {
        sess.log.push({ type: 'err', text: 'ERROR: ' + e.message, hint: e.hint });
        steps.push({ text: 'ERROR: ' + e.message, verdict: 'err' });
        if (e.fatal && sess.inTx) sess.failed = true;
      }
      if (sess._implicit) this.endTx(sess, false, steps, true);
    }
    sess._implicit = false;
    const b = this.bufStats;
    this.trace.buffers = (b.hit + b.read + b.dirtied + b.written + b.extended) ? { ...b } : null;
  }

  beginTx(sess, iso) { sess.inTx = true; sess.xid = null; sess.snapshot = null; sess.failed = false; sess.txIso = iso || sess.iso; }

  endTx(sess, commit, steps, implicit = false) {
    let msg;
    if (sess.xid != null) {
      this.clog[sess.xid] = commit ? 'committed' : 'aborted';
      msg = `xid ${sess.xid} marked ${commit ? 'COMMITTED' : 'ABORTED'} in pg_xact.` + (commit ? '' : ' Its tuples stay on the pages until pruning or VACUUM removes them.');
    } else msg = 'Transaction never wrote anything, so it never got an xid; nothing to record.';
    if (steps) steps.push({ text: (implicit ? '(autocommit) ' : '') + msg, verdict: commit ? 'ok' : 'abort' });
    sess.inTx = false; sess.xid = null; sess.snapshot = null; sess.failed = false; sess.txIso = null;
    return msg;
  }

  assignXid(sess, steps) {
    if (sess.xid == null) {
      sess.xid = this.nextXid++;
      this.clog[sess.xid] = 'in progress';
      if (steps) steps.push({ text: `first write in this transaction → assigned xid ${sess.xid} (published in the ProcArray so other snapshots see it as running)` });
    }
    return sess.xid;
  }

  statementSnapshot(sess, steps) {
    const iso = sess.inTx ? sess.txIso : sess.iso;
    if (iso === 'REPEATABLE READ' && sess.snapshot) { steps.push({ text: `REPEATABLE READ → reusing transaction snapshot ${this.snapStr(sess.snapshot)}` }); sess.lastSnapshot = sess.snapshot; return sess.snapshot; }
    const snap = this.takeSnapshot(sess);
    sess.snapshot = snap;
    sess.lastSnapshot = snap;
    steps.push({ text: `${iso === 'REPEATABLE READ' ? 'REPEATABLE READ → first statement, taking the transaction snapshot' : 'READ COMMITTED → fresh snapshot for this statement'} from the ProcArray: ${this.snapStr(snap)}  (xmin:xmax:in-progress)` });
    return snap;
  }

  dispatch(sess, sql, steps) {
    const low = sql.toLowerCase();
    let m;
    if (sess.failed && !/^(rollback|abort|commit|end)\b/.test(low)) throw new SimError('current transaction is aborted, commands ignored until end of transaction block', { fatal: false, hint: 'Run ROLLBACK.' });
    if ((m = low.match(/^(begin|start transaction)(?:\s+transaction)?(?:\s+isolation\s+level\s+(read\s+committed|repeatable\s+read|serializable))?$/))) {
      this.trace.plan = 'Transaction control';
      if (sess.inTx) { steps.push({ text: 'already in a transaction; BEGIN ignored' }); return { type: 'warn', text: 'WARNING: there is already a transaction in progress' }; }
      let iso = m[2] ? m[2].replace(/\s+/g, ' ').toUpperCase() : null;
      if (iso === 'SERIALIZABLE') iso = 'REPEATABLE READ';
      this.beginTx(sess, iso);
      steps.push({ text: `transaction block opened (${sess.txIso}). No xid yet: Postgres assigns one lazily on the first write. Snapshot is taken at the first statement, not at BEGIN.` });
      return { type: 'ok', text: 'BEGIN' + (m[2] && /serial/.test(m[2]) ? ' (SERIALIZABLE is simulated as REPEATABLE READ)' : '') };
    }
    if (/^(commit|end)$/.test(low)) {
      this.trace.plan = 'Transaction control';
      if (!sess.inTx) { steps.push({ text: 'no transaction in progress' }); return { type: 'warn', text: 'WARNING: there is no transaction in progress' }; }
      if (sess.failed) { this.endTx(sess, false, steps); return { type: 'ok', text: 'ROLLBACK (transaction had failed, so COMMIT rolls back)' }; }
      this.endTx(sess, true, steps); return { type: 'ok', text: 'COMMIT' };
    }
    if (/^(rollback|abort)$/.test(low)) {
      this.trace.plan = 'Transaction control';
      if (!sess.inTx) { steps.push({ text: 'no transaction in progress' }); return { type: 'warn', text: 'WARNING: there is no transaction in progress' }; }
      this.endTx(sess, false, steps); return { type: 'ok', text: 'ROLLBACK' };
    }
    if ((m = low.match(/^set\s+(?:session\s+characteristics\s+as\s+)?transaction\s+isolation\s+level\s+(read\s+committed|repeatable\s+read|serializable)$/))) {
      this.trace.plan = 'SET';
      let iso = m[1].replace(/\s+/g, ' ').toUpperCase(); if (iso === 'SERIALIZABLE') iso = 'REPEATABLE READ';
      if (sess.inTx) { if (sess.snapshot) throw new SimError('SET TRANSACTION ISOLATION LEVEL must be called before any query', { fatal: true }); sess.txIso = iso; }
      else sess.iso = iso;
      steps.push({ text: `isolation level → ${iso}` });
      return { type: 'ok', text: 'SET' };
    }
    if ((m = low.match(/^set\s+(enable_indexscan|enable_seqscan)\s*(?:=|to)\s*(on|off|true|false)$/))) {
      this.trace.plan = 'SET';
      const on = m[2] === 'on' || m[2] === 'true';
      if (m[1] === 'enable_indexscan') sess.enableIndexScan = on; else sess.enableSeqScan = on;
      steps.push({ text: `${m[1]} = ${on ? 'on' : 'off'} for session ${sess.name}` });
      return { type: 'ok', text: 'SET' };
    }
    if (/^set\s+shared_buffers\b/.test(low)) {
      this.trace.plan = 'SET';
      throw new SimError('parameter "shared_buffers" cannot be changed without restarting the server', { fatal: true, hint: 'Use the shared_buffers control in the Shared memory panel. It simulates a restart.' });
    }
    if (low === 'checkpoint') {
      if (sess.inTx) { /* allowed in PG */ }
      this.trace.plan = 'CHECKPOINT';
      steps.push({ text: 'write every dirty buffer back to its data file. (Real Postgres first makes sure the WAL describing those changes is on disk; WAL isn\'t modelled here.)', head: true });
      const n = this.checkpoint(steps);
      if (!n) steps.push({ text: 'no dirty buffers; nothing to write' });
      return { type: 'ok', text: 'CHECKPOINT' };
    }
    if (/^vacuum(\s+verbose)?(\s+accounts)?$/.test(low)) {
      if (sess.inTx) throw new SimError('VACUUM cannot run inside a transaction block', { fatal: true });
      return this.vacuum(steps);
    }
    if ((m = low.match(/^alter\s+table\s+accounts\s+set\s*\(\s*fillfactor\s*=\s*(\d+)\s*\)$/))) {
      const ff = Number(m[1]);
      if (ff < 10 || ff > 100) throw new SimError(`value ${ff} out of bounds for option "fillfactor"`, { hint: 'Valid values are between 10 and 100.' });
      this.fillfactor = ff;
      this.trace.plan = 'ALTER TABLE';
      steps.push({ text: `fillfactor = ${ff}: INSERTs now stop filling a page at ${ff}% (${this.insertCap()} of ${PAGE_CAP} tuples in this lab). The rest is left for UPDATEs of rows already on that page. Existing pages are not rewritten.` });
      return { type: 'ok', text: 'ALTER TABLE' };
    }
    if (/^alter\s+table\s+accounts\s+add\s+column\s+notes\s+text$/.test(low)) {
      this.hasNotes = true;
      this.trace.plan = 'ALTER TABLE';
      steps.push({ text: 'added column notes. This only changes the catalog: no existing row is rewritten, and reading an old row simply returns NULL for the new column.' });
      return { type: 'ok', text: 'ALTER TABLE' };
    }
    if ((m = sql.match(/^create\s+index(?:\s+(\w+))?\s+on\s+(\w+)\s*\(([^)]*)\)(?:\s+include\s*\(([^)]*)\))?$/i))) return this.createIndex(sess, m[1], m[2], m[3].split(',').map(x => x.trim().toLowerCase()), steps, m[4] ? m[4].split(',').map(x => x.trim().toLowerCase()) : []);
    if ((m = sql.match(/^drop\s+index\s+(\w+)$/i))) {
      this.trace.plan = 'DROP INDEX';
      const name = m[1].toLowerCase();
      if (!this.indexes[name]) throw new SimError(`index "${m[1]}" does not exist`, { hint: 'Index names look like accounts_id_idx.' });
      delete this.indexes[name];
      this.buffers.forEach((b, i) => { if (b && b.rel === name) this.buffers[i] = null; });
      steps.push({ text: `dropped index ${name}; its buffers were invalidated and its file deleted` });
      return { type: 'ok', text: 'DROP INDEX' };
    }

    let explain = false, body = sql;
    if (/^explain\s+/i.test(body)) { explain = true; body = body.replace(/^explain\s+(\(\s*[\w\s,]*\)\s*)?/i, ''); }
    const isSelect = /^select\b/i.test(body), isWrite = /^(insert|update|delete)\b/i.test(body);
    if (!isSelect && !isWrite) throw new SimError(`syntax error or unsupported statement`, { fatal: true, hint: 'Supported: BEGIN, COMMIT, ROLLBACK, SELECT, INSERT, UPDATE, DELETE, CREATE INDEX, DROP INDEX, VACUUM, CHECKPOINT, EXPLAIN, SET.' });
    if (!sess.inTx && !explain) { this.beginTx(sess); sess._implicit = true; steps.push({ text: `no BEGIN → this statement runs in its own transaction (autocommit)` }); }
    let res;
    if (isSelect) res = this.select(sess, body, steps, explain);
    else if (/^insert/i.test(body)) res = explain ? this.explainOnly('Insert on accounts', steps) : this.insert(sess, body, steps);
    else if (/^update/i.test(body)) res = this.update(sess, body, steps, explain);
    else res = this.del(sess, body, steps, explain);
    if (sess._implicit) { this.endTx(sess, true, steps, true); sess._implicit = false; }
    return res;
  }

  explainOnly(plan, steps) { this.trace.plan = plan; steps.push({ text: 'EXPLAIN only shows the plan; nothing executed.' }); return { type: 'plan', text: plan }; }

  checkTable(name) { if (name.toLowerCase() !== TABLE) throw new SimError(`relation "${name}" does not exist`, { hint: 'This lab has one table: accounts(id int, name text, balance int, notes text).' }); }

  parseCond(str) {
    const m = str.trim().match(/^(\w+)\s*(=|<>|!=|<=|>=|<|>)\s*(.+)$/);
    if (!m) throw new SimError(`could not parse condition "${str}"`, { hint: "Use conditions like id = 1, name = 'bob' or balance > 100, joined with AND." });
    const col = m[1].toLowerCase();
    if (!COLS.includes(col) && col !== 'ctid') throw new SimError(`column "${col}" does not exist`);
    if (col === 'notes') throw new SimError('filtering on notes isn\'t supported in this lab', { hint: 'Filter on id, name or balance.' });
    if (col === 'ctid') { const t = String(parseLiteral(m[3])).match(/^\((\d+),(\d+)\)$/); if (!t || m[2] !== '=') throw new SimError('use WHERE ctid = \'(page,lp)\''); return { col, op: '=', val: { p: +t[1], lp: +t[2] } }; }
    return { col, op: m[2] === '!=' ? '<>' : m[2], val: parseLiteral(m[3]) };
  }

  parseWhere(str) {
    if (!str) return null;
    return str.split(/\s+and\s+/i).map(s => this.parseCond(s));
  }

  condOk(w, v) {
    const c = cmp(v, w.val);
    return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[w.op];
  }

  matches(where, data) {
    if (!where) return true;
    return where.every(w => w.col === 'ctid' || !(w.col in data) || this.condOk(w, data[w.col]));
  }

  condStr(conds) { return conds.map(w => `${w.col} ${w.op} ${fmtVal(w.val)}`).join(' AND '); }

  entryData(idx, e) { const d = {}; idx.cols.forEach((c, i) => d[c] = e.key[i]); return { ...d, ...(e.inc || {}) }; }

  // How much of this index can a WHERE clause use to navigate the tree?
  indexFit(idx, where) {
    const bound = [];
    for (const c of idx.cols) {
      const cs = where.filter(w => w.col === c && w.op !== '<>');
      if (!cs.length) break;
      const eq = cs.find(w => w.op === '=');
      if (eq) { bound.push(eq); continue; }
      bound.push(...cs); break;
    }
    const boundCols = new Set(bound.map(w => w.col));
    const idxCols = new Set([...idx.cols, ...(idx.include || [])]);
    const inIndex = where.filter(w => !bound.includes(w) && idx.cols.includes(w.col));
    const heapFilter = where.filter(w => !bound.includes(w) && !inIndex.includes(w));
    return { bound, boundCols, inIndex, heapFilter, idxCols };
  }

  choosePlan(sess, where, cols) {
    if (where && where.some(w => w.col === 'ctid')) return { kind: 'tid' };
    if (!where) return { kind: 'seq', reason: 'no WHERE clause' };
    let best = null;
    for (const idx of Object.values(this.indexes)) {
      const fit = this.indexFit(idx, where);
      if (!fit.bound.length) continue;
      const score = fit.bound.length * 10 + fit.inIndex.length;
      if (!best || score > best.score) best = { idx, fit, score };
    }
    if (best && (sess.enableIndexScan || !sess.enableSeqScan)) {
      const need = [...(cols || []), ...where.map(w => w.col)];
      const ios = !!(cols && cols.length) && need.every(c => best.fit.idxCols.has(c));
      return { kind: 'index', idx: best.idx, fit: best.fit, ios };
    }
    const lead = Object.values(this.indexes).map(i => i.cols[0]);
    return { kind: 'seq', reason: best ? 'enable_indexscan = off' : Object.keys(this.indexes).length ? `no index starts with ${[...new Set(where.map(w => w.col))].join(' or ')}` : `no index` };
  }

  newStats() { return { heapPages: new Set(), indexPages: 0, toastPages: 0, tuplesChecked: 0, visible: 0, invisible: 0, returned: 0, heapFetches: 0, vmSkips: 0, entriesRead: 0, entriesPassed: 0 }; }

  scan(sess, where, snap, steps, label, cols) {
    const plan = this.choosePlan(sess, where, cols);
    this.lastPlan = plan;
    const wtxt = where ? ` (${this.condStr(where)})` : '';
    const out = [];
    const stats = this.newStats();
    this.trace.stats = stats;
    const check = (tid, t, extra = '', filter = where, filterLabel = 'WHERE') => {
      stats.tuplesChecked++; stats.heapPages.add(tid.p);
      const sub = [];
      const v = this.visibility(t, snap, sess, sub);
      const flag = t.heapOnly ? ' [heap-only]' : '';
      if (!v.visible) {
        stats.invisible++;
        steps.push({ text: `${tidStr(tid)}${extra}${flag} ${fmtRow(t.data)} → INVISIBLE: ${v.why}`, tid, rel: TABLE, verdict: 'invis' });
        steps.push(...sub);
        this.touched[tkey(TABLE, tid)] = 'invis';
        return false;
      }
      stats.visible++;
      const hasF = filter && filter.length;
      const ok = !hasF || this.matches(filter, t.data);
      steps.push({ text: `${tidStr(tid)}${extra}${flag} ${fmtRow(t.data)} → visible (${v.why})${hasF ? (ok ? `, passes ${filterLabel}` : `, rejected by ${filterLabel}`) : ''}`, tid, rel: TABLE, verdict: ok ? 'vis' : 'skip' });
      steps.push(...sub);
      this.touched[tkey(TABLE, tid)] = ok ? 'vis' : 'skip';
      if (ok) { out.push({ tid, tuple: t }); stats.returned++; }
      return true;
    };
    if (plan.kind === 'tid') {
      const tid = where.find(w => w.col === 'ctid').val;
      this.trace.plan = `${label}Tid Scan on accounts (ctid = '${tidStr(tid)}')`;
      steps.push({ text: `Tid Scan: the ctid is a physical address, so go straight to page ${tid.p}, line pointer ${tid.lp}. No searching.`, head: true });
      const lp = this.getLp(this.heap, tid);
      if (this.heap.pages[tid.p]) { this.bufAccess(TABLE, tid.p, steps); stats.heapPages.add(tid.p); }
      if (!lp) steps.push({ text: `${tidStr(tid)} does not exist`, sub: true });
      else if (lp.state !== 'normal') steps.push({ text: `${tidStr(tid)} line pointer is ${lp.state}; no tuple here`, sub: true });
      else check(tid, lp.tuple);
      stats.heapPages = stats.heapPages.size;
      return out;
    }
    if (plan.kind === 'seq') {
      this.trace.plan = `${label}Seq Scan on accounts${wtxt}  [${plan.reason}]`;
      steps.push({ text: `Seq Scan: read every page in order, check every tuple's visibility, then the filter.`, head: true });
      for (const pg of this.heap.pages) {
        steps.push({ text: `read heap page ${pg.id}`, head: true });
        this.bufAccess(TABLE, pg.id, steps);
        stats.heapPages.add(pg.id);
        pg.lps.forEach((lp, i) => {
          const tid = { p: pg.id, lp: i + 1 };
          if (lp.state === 'unused') steps.push({ text: `${tidStr(tid)} line pointer unused, skip`, sub: true });
          else if (lp.state === 'dead') steps.push({ text: `${tidStr(tid)} line pointer dead (tuple already pruned away), skip`, sub: true });
          else if (lp.state === 'redirect') steps.push({ text: `${tidStr(tid)} redirect → lp ${lp.to}; a seq scan ignores redirects and reaches that tuple on its own`, sub: true });
          else check(tid, lp.tuple);
        });
      }
    } else {
      const idx = plan.idx, fit = plan.fit, leaves = this.indexLeaves(idx);
      this.trace.plan = `${label}Index ${plan.ios ? 'Only ' : ''}Scan using ${idx.name} on accounts${wtxt}`;
      if (plan.ios) steps.push({ text: `Index Only Scan: every column the query needs is stored in the index. But the index can't tell whether a row is visible to this snapshot, so for each entry check the visibility map first.`, head: true });
      else steps.push({ text: `Index Scan: walk the B-tree to the matching keys, collect heap TIDs, then fetch each heap tuple to check visibility. The index has no xmin/xmax, so it can't tell which versions are alive.`, head: true });
      steps.push({ text: `Index Cond (used to navigate the tree): ${this.condStr(fit.bound)}`, sub: true });
      if (fit.inIndex.length) steps.push({ text: `checked on each index entry, but can't narrow the search: ${this.condStr(fit.inIndex)} (${idx.cols[0]} comes first in this index)`, sub: true });
      if (fit.heapFilter.length && !plan.ios) steps.push({ text: `Filter, checked on the heap row: ${this.condStr(fit.heapFilter)} (not in this index)`, sub: true });
      this.bufAccess(idx.name, 0, steps); stats.indexPages++;
      const hits = [], readLeaves = [];
      leaves.forEach((leaf, li) => {
        const inRange = leaf.filter(e => this.matches(fit.bound, this.entryData(idx, e)));
        if (!inRange.length) return;
        stats.indexPages++; readLeaves.push(li); this.bufAccess(idx.name, li + 1, steps);
        stats.entriesRead += inRange.length;
        inRange.forEach(e => { const pass = this.matches(fit.inIndex, this.entryData(idx, e)); hits.push({ e, li, pass }); });
      });
      steps.push({ text: `index root page → descend to leaf page${readLeaves.length > 1 ? 's' : ''} ${readLeaves.length ? readLeaves.map(l => 'L' + (l + 1)).join(', ') : '(none matched)'}; read ${stats.entriesRead} entr${stats.entriesRead === 1 ? 'y' : 'ies'} in range`, head: true });
      const keyStr = e => idx.cols.length > 1 ? `(${e.key.map(fmtVal).join(', ')})` : fmtVal(e.key[0]);
      if (hits.length) steps.push({ text: `entries: ${hits.map(h => `${keyStr(h.e)}→${tidStr(h.e.tid)}${fit.inIndex.length ? (h.pass ? ' ✓' : ' ✗') : ''}`).join('  ')}`, sub: true });
      hits.forEach(h => { this.touchedIdx[idx.name + '|' + tidKey(h.e.tid)] = h.pass ? 'hit' : 'read'; });
      for (const { e, pass } of hits) {
        if (!pass) continue;
        stats.entriesPassed++;
        const pg = this.heap.pages[e.tid.p];
        if (plan.ios && pg && pg.allVisible) {
          stats.vmSkips++;
          steps.push({ text: `${keyStr(e)} → ${tidStr(e.tid)}: visibility map says page ${e.tid.p} is all-visible → return the values straight from the index, skip the heap`, verdict: 'vm' });
          const d = this.entryData(idx, e);
          if (this.matches(where, d)) { out.push({ tid: e.tid, tuple: null, data: d }); stats.returned++; }
          continue;
        }
        if (plan.ios) { stats.heapFetches++; steps.push({ text: `${keyStr(e)} → ${tidStr(e.tid)}: page ${e.tid.p} not marked all-visible → must fetch the heap tuple to check visibility (a "heap fetch")`, sub: true }); }
        const lp = this.getLp(this.heap, e.tid);
        this.bufAccess(TABLE, e.tid.p, steps);
        stats.heapPages.add(e.tid.p);
        if (!lp || lp.state === 'unused') { steps.push({ text: `${tidStr(e.tid)} line pointer unused, skip`, sub: true }); continue; }
        if (lp.state === 'dead') { steps.push({ text: `${tidStr(e.tid)} heap fetch: line pointer is dead (pruned). The index entry is stale until VACUUM removes it.`, tid: e.tid, rel: TABLE, verdict: 'invis' }); continue; }
        let start = e.tid.lp, requireHO = false;
        if (lp.state === 'redirect') { steps.push({ text: `${tidStr(e.tid)} heap fetch: line pointer is a redirect → lp ${lp.to}`, verdict: 'hot' }); start = lp.to; requireHO = true; }
        const chain = this.chainFrom(pg, start, requireHO);
        if (chain.length > 1) steps.push({ text: `HOT chain on page ${pg.id}: ${chain.map(c => 'lp ' + c).join(' → ')}. Walk it until a version is visible.`, verdict: 'hot' });
        for (let ci = 0; ci < chain.length; ci++) {
          const tid = { p: pg.id, lp: chain[ci] };
          const vis = check(tid, pg.lps[chain[ci] - 1].tuple, ci === 0 && lp.state !== 'redirect' ? ' (heap fetch)' : ' (via HOT chain)', plan.ios ? where : [...fit.heapFilter, ...fit.bound, ...fit.inIndex], 'Filter');
          if (vis) { if (ci < chain.length - 1) steps.push({ text: `found the visible version; rest of the chain not needed`, sub: true }); break; }
        }
      }
    }
    stats.heapPages = stats.heapPages.size;
    return out;
  }

  parseSelectList(str) {
    const cols = [];
    str.split(',').map(s => s.trim().toLowerCase()).forEach(c => {
      if (c === '*') cols.push(...COLS.filter(x => x !== 'notes' || this.hasNotes));
      else if (COLS.includes(c) || SYS_COLS.includes(c)) cols.push(c);
      else throw new SimError(`column "${c}" does not exist`);
    });
    return cols;
  }

  select(sess, body, steps, explain) {
    let m = body.match(/^select\s+(txid_current|pg_current_xact_id)\s*\(\s*\)$/i);
    if (m) {
      this.trace.plan = 'Result';
      if (explain) return this.explainOnly('Result', steps);
      const x = this.assignXid(sess, steps);
      return { type: 'rows', cols: [m[1].toLowerCase()], rows: [[x]] };
    }
    m = body.match(/^select\s+(pg_current_snapshot|txid_current_snapshot)\s*\(\s*\)$/i);
    if (m) {
      this.trace.plan = 'Result';
      if (explain) return this.explainOnly('Result', steps);
      const s = this.statementSnapshot(sess, steps);
      return { type: 'rows', cols: [m[1].toLowerCase()], rows: [[this.snapStr(s)]] };
    }
    m = body.match(/^select\s+(.+?)\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(\w+))?$/i);
    if (!m) throw new SimError('could not parse SELECT', { hint: "Try: SELECT ctid, xmin, xmax, * FROM accounts WHERE id = 1" });
    this.checkTable(m[2]);
    const cols = this.parseSelectList(m[1]);
    const where = this.parseWhere(m[3]);
    if (explain) { const p = this.choosePlan(sess, where, cols); this.trace.plan = p.kind === 'tid' ? 'Tid Scan on accounts' : p.kind === 'index' ? `Index ${p.ios ? 'Only ' : ''}Scan using ${p.idx.name} on accounts` : `Seq Scan on accounts  [${p.reason}]`; steps.push({ text: 'EXPLAIN only shows the plan; nothing executed.' }); return { type: 'plan', text: this.trace.plan }; }
    const snap = this.statementSnapshot(sess, steps);
    let rows = this.scan(sess, where, snap, steps, '', cols);
    rows = rows.map(r => r.tuple ? r : { ...r, tuple: { data: r.data, toast: null, xmin: '', xmax: '' } });
    if (m[4]) { const oc = m[4].toLowerCase(); if (!COLS.includes(oc)) throw new SimError(`column "${oc}" does not exist`); rows = rows.slice().sort((a, b) => cmp(a.tuple.data[oc], b.tuple.data[oc])); }
    const wantsNotes = cols.includes('notes');
    if (this.trace.stats && this.lastPlan && this.lastPlan.ios) steps.push({ text: `Heap Fetches: ${this.trace.stats.heapFetches} (rows that needed a heap visit), ${this.trace.stats.vmSkips} answered from the index alone`, verdict: 'vm' });
    const anyToasted = rows.some(r => r.tuple.toast && (r.tuple.toast.mode === 'external' || r.tuple.toast.mode === 'compressed'));
    if (anyToasted) {
      if (wantsNotes) { steps.push({ text: 'Output needs notes → detoast values that were compressed or moved out of line', head: true }); rows.forEach(r => this.detoast(r.tid, r.tuple, steps, this.trace.stats)); }
      else steps.push({ text: `notes wasn't requested, so no TOAST value was decompressed or fetched. ${TOAST_REL} was never touched.`, verdict: 'ok' });
    }
    return {
      type: 'rows', cols, rows: rows.map(({ tid, tuple }) => cols.map(c => c === 'ctid' ? tidStr(tid) : c === 'xmin' ? tuple.xmin : c === 'xmax' ? tuple.xmax : c === 'notes' ? fmtNotes(tuple.data.notes) : tuple.data[c]))
    };
  }

  splitRows(s) {
    const rows = []; let depth = 0, q = false, start = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") q = !q;
      if (q) continue;
      if (ch === '(') { if (depth === 0) start = i + 1; depth++; }
      else if (ch === ')') { depth--; if (depth === 0) rows.push(s.slice(start, i)); }
    }
    return rows;
  }

  insert(sess, body, steps) {
    const m = body.match(/^insert\s+into\s+(\w+)\s*(?:\(([^)]*)\))?\s*values\s*(.+)$/i);
    if (!m) throw new SimError('could not parse INSERT', { hint: "Try: INSERT INTO accounts VALUES (4, 'dave', 400)" });
    this.checkTable(m[1]);
    const cols = m[2] ? m[2].split(',').map(s => s.trim().toLowerCase()) : COLS.filter(x => x !== 'notes' || this.hasNotes);
    cols.forEach(c => { if (!COLS.includes(c)) throw new SimError(`column "${c}" does not exist`); });
    const tuples = this.splitRows(m[3]).map(r => splitTop(r).map(parseLiteral));
    if (!tuples.length) throw new SimError('INSERT needs at least one (…) row');
    this.trace.plan = 'Insert on accounts';
    for (const vals of tuples) if (vals.length > cols.length) throw new SimError('INSERT has more expressions than target columns');
    const xid = this.assignXid(sess, steps);
    for (const vals of tuples) {
      const data = { id: null, name: null, balance: null, notes: null };
      cols.forEach((c, i) => { if (i < vals.length) data[c] = vals[i]; });
      this.insertRow(data, xid, null, steps);
    }
    return { type: 'ok', text: `INSERT 0 ${tuples.length}` };
  }

  checkWritable(sess, tid, t, steps) {
    if (!t.xmax || t.xmax === sess.xid) return;
    const ys = this.status(t.xmax);
    if (ys === 'aborted') { steps.push({ text: `  xmax ${t.xmax} was aborted, so the old xmax can be overwritten`, sub: true }); return; }
    if (ys === 'in progress') throw new SimError(`⏳ Session ${sess.name} would block here: ${tidStr(tid)} is being updated/deleted by xid ${t.xmax}, which hasn't committed or rolled back.`, { kind: 'blocked', fatal: false, hint: `In real Postgres this statement just waits. Finish the other transaction, then run this again. (Under READ COMMITTED Postgres would then re-check the newest version of the row; under REPEATABLE READ it fails if the other side committed.)` });
    throw new SimError(`could not serialize access due to concurrent update`, { fatal: true, hint: `${tidStr(tid)} was changed by xid ${t.xmax}, which committed after this REPEATABLE READ snapshot. Run ROLLBACK and retry the transaction.` });
  }

  update(sess, body, steps, explain) {
    const m = body.match(/^update\s+(\w+)\s+set\s+(.+?)(?:\s+where\s+(.+))?$/i);
    if (!m) throw new SimError('could not parse UPDATE', { hint: 'Try: UPDATE accounts SET balance = balance - 10 WHERE id = 1' });
    this.checkTable(m[1]);
    const sets = splitTop(m[2]).map(s => {
      const a = s.trim().match(/^(\w+)\s*=\s*(.+)$/);
      if (!a) throw new SimError(`could not parse SET "${s}"`);
      const col = a[1].toLowerCase(); if (!COLS.includes(col)) throw new SimError(`column "${col}" does not exist`);
      return { col, expr: a[2].trim() };
    });
    const where = this.parseWhere(m[3]);
    if (explain) { const p = this.choosePlan(sess, where); return this.explainOnly(`Update on accounts → ${p.kind === 'index' ? 'Index Scan using ' + p.idx.name : 'Seq Scan'}`, steps); }
    const snap = this.statementSnapshot(sess, steps);
    const targets = this.scan(sess, where, snap, steps, 'Update on accounts → ');
    if (!targets.length) { steps.push({ text: 'no visible rows matched; nothing to update' }); return { type: 'ok', text: 'UPDATE 0' }; }
    for (const { tid, tuple } of targets) this.checkWritable(sess, tid, tuple, steps);
    const xid = this.assignXid(sess, steps);
    const setsNotes = sets.some(s => s.col === 'notes');
    for (const { tid, tuple } of targets) {
      steps.push({ text: `update ${tidStr(tid)}: an UPDATE never changes a tuple in place. Stamp xmax on the old version, write a whole new version.`, head: true });
      const nd = { ...tuple.data };
      for (const s of sets) nd[s.col] = evalExpr(s.expr, tuple.data);
      const pg = this.heap.pages[tid.p];
      let room = this.pageSlot(pg);
      if (!room) {
        steps.push({ text: `page ${tid.p} has no room for the new version → prune it first. (Real Postgres prunes on the read just before, once a page is nearly full.)`, sub: true });
        this.prunePage(this.heap, pg, this.horizon(), steps);
        room = this.pageSlot(pg);
      }
      tuple.xmax = xid; delete tuple.hints.xmaxC; delete tuple.hints.xmaxA;
      this.bufAccess(TABLE, tid.p, steps, { dirty: true });
      this.clearVM(tid.p, steps);
      steps.push({ text: `old version ${tidStr(tid)}: set xmax = ${xid}`, tid, rel: TABLE, verdict: 'del' });
      this.touched[tkey(TABLE, tid)] = 'del';
      // TOAST
      let toast;
      if (setsNotes && cmp(nd.notes, tuple.data.notes) !== 0) {
        this.toastDelete(tuple.toast, xid, steps, 'because notes was replaced');
        toast = this.toastValue(nd, xid, steps);
      } else {
        toast = tuple.toast;
        if (toast && toast.mode === 'external') steps.push({ text: `notes unchanged → new version reuses the same TOAST pointer (chunk_id ${toast.chunkId}). No chunks copied.`, verdict: 'toast' });
      }
      const changed = [...new Set(Object.values(this.indexes).flatMap(ix => [...ix.cols, ...(ix.include || [])]))].filter(c => cmp(tuple.data[c], nd[c]) !== 0);
      const hasIdx = Object.keys(this.indexes).length;
      let res;
      if (room && !changed.length) {
        res = this.insertRow(nd, xid, tid.p, steps, { toast, heapOnly: true, slot: room });
        tuple.hotUpdated = true;
        steps.push({ text: `HOT update: no indexed column changed ${hasIdx ? '' : '(there are no indexes) '}and page ${tid.p} had room, so the new version is a heap-only tuple. ${hasIdx ? `Skipped ${hasIdx} index insert${hasIdx > 1 ? 's' : ''}; index entries still point at the chain's root.` : 'Any future index will reach it through the chain.'}`, verdict: 'hot' });
      } else {
        const why = changed.length ? `indexed column${changed.length > 1 ? 's' : ''} ${changed.join(', ')} changed` : `page ${tid.p} has no room even after pruning`;
        steps.push({ text: `not a HOT update: ${why}. New version gets its own entry in every index.`, verdict: 'nohot' });
        tuple.hotUpdated = false;
        res = this.insertRow(nd, xid, tid.p, steps, room ? { toast, slot: room } : { toast });
      }
      tuple.ctid = { ...res.tid };
      steps.push({ text: `  old ${tidStr(tid)}.t_ctid → ${tidStr(res.tid)} (forward pointer to the newer version)`, sub: true });
    }
    return { type: 'ok', text: `UPDATE ${targets.length}` };
  }

  del(sess, body, steps, explain) {
    const m = body.match(/^delete\s+from\s+(\w+)(?:\s+where\s+(.+))?$/i);
    if (!m) throw new SimError('could not parse DELETE', { hint: 'Try: DELETE FROM accounts WHERE id = 2' });
    this.checkTable(m[1]);
    const where = this.parseWhere(m[2]);
    if (explain) { const p = this.choosePlan(sess, where); return this.explainOnly(`Delete on accounts → ${p.kind === 'index' ? 'Index Scan using ' + p.idx.name : 'Seq Scan'}`, steps); }
    const snap = this.statementSnapshot(sess, steps);
    const targets = this.scan(sess, where, snap, steps, 'Delete on accounts → ');
    if (!targets.length) { steps.push({ text: 'no visible rows matched; nothing to delete' }); return { type: 'ok', text: 'DELETE 0' }; }
    for (const { tid, tuple } of targets) this.checkWritable(sess, tid, tuple, steps);
    const xid = this.assignXid(sess, steps);
    steps.push({ text: `A DELETE only stamps xmax. The bytes stay on the page until pruning or VACUUM.`, head: true });
    for (const { tid, tuple } of targets) {
      tuple.xmax = xid; tuple.hotUpdated = false; delete tuple.hints.xmaxC; delete tuple.hints.xmaxA;
      this.bufAccess(TABLE, tid.p, steps, { dirty: true });
      this.clearVM(tid.p, steps);
      steps.push({ text: `${tidStr(tid)}: set xmax = ${xid}`, tid, rel: TABLE, verdict: 'del' });
      this.touched[tkey(TABLE, tid)] = 'del';
      this.toastDelete(tuple.toast, xid, steps, 'because its row was deleted');
    }
    return { type: 'ok', text: `DELETE ${targets.length}` };
  }

  createIndex(sess, name, table, cols, steps, include = []) {
    this.checkTable(table);
    cols.forEach(c => { if (!COLS.includes(c)) throw new SimError(`column "${c}" does not exist`); if (c === 'notes') throw new SimError('indexing notes isn\'t supported in this lab', { fatal: false }); });
    include.forEach(c => { if (!COLS.includes(c) || c === 'notes' || cols.includes(c)) throw new SimError(`can't INCLUDE column "${c}" here`, { fatal: false }); });
    const iname = (name || `accounts_${[...cols, ...include].join('_')}_idx`).toLowerCase();
    if (this.indexes[iname]) throw new SimError(`relation "${iname}" already exists`, { fatal: false });
    this.trace.plan = 'CREATE INDEX (B-tree)';
    const idx = { name: iname, cols, col: cols[0], include, entries: [] };
    if (cols.length > 1) steps.push({ text: `multicolumn B-tree: entries are sorted by ${cols[0]} first, then by ${cols.slice(1).join(', then ')} among equal ${cols[0]} values.`, head: true });
    if (include.length) steps.push({ text: `INCLUDE (${include.join(', ')}): each leaf entry also stores ${include.join(', ')}. The tree is still sorted and searched by ${cols.join(', ')} only.`, head: true });
    steps.push({ text: `scan the heap and add one entry per HOT chain (key → ctid of the chain's root). Heap-only tuples get no entry of their own.`, head: true });
    for (const pg of this.heap.pages) {
      this.bufAccess(TABLE, pg.id, steps);
      pg.lps.forEach((lp, i) => {
        const tid = { p: pg.id, lp: i + 1 };
        let t;
        if (lp.state === 'redirect') { const ch = this.chainFrom(pg, lp.to, true); t = ch.length ? pg.lps[ch[ch.length - 1] - 1].tuple : null; }
        else if (lp.state === 'normal' && !lp.tuple.heapOnly) { const ch = this.chainFrom(pg, i + 1, false); t = pg.lps[ch[ch.length - 1] - 1].tuple; }
        if (!t) return;
        if (this.tupleState(t) === 'aborted') return;
        const key = cols.map(c => t.data[c]);
        idx.entries.push({ key, tid, inc: this.incOf(idx, t.data) });
        steps.push({ text: `${tidStr(tid)} key ${key.length > 1 ? '(' + key.map(fmtVal).join(', ') + ')' : fmtVal(key[0])}${lp.state === 'redirect' ? '  (redirect root of a HOT chain)' : ''}`, sub: true, tid, rel: TABLE });
      });
    }
    this.sortIndex(idx);
    this.indexes[iname] = idx;
    steps.push({ text: `sorted ${idx.entries.length} entries into ${this.indexLeaves(idx).length} leaf page(s) under one root page, written straight to the new index file (an index build bypasses shared buffers)` });
    return { type: 'ok', text: 'CREATE INDEX' };
  }

  vacuum(steps) {
    this.trace.plan = 'VACUUM accounts (and its TOAST table)';
    const h = this.horizon();
    steps.push({ text: `removal horizon = ${h}: the oldest xid any open transaction or snapshot might still need. Versions deleted by a committed xid older than this are invisible to everyone.`, head: true });
    steps.push({ text: `pass 1: prune every heap page`, head: true });
    let kept = 0;
    for (const pg of this.heap.pages) {
      this.bufAccess(TABLE, pg.id, steps);
      pg.lps.forEach((lp, i) => {
        if (lp.state !== 'normal') return;
        const t = lp.tuple;
        if (t.xmax && this.status(t.xmax) === 'committed' && this.status(t.xmin) === 'committed' && t.xmax >= h) { kept++; steps.push({ text: `${tidStr({ p: pg.id, lp: i + 1 })} KEPT: recently dead. xmax ${t.xmax} committed, but a snapshot from before it may still need this version.`, tid: { p: pg.id, lp: i + 1 }, rel: TABLE, verdict: 'keep' }); this.touched[tkey(TABLE, { p: pg.id, lp: i + 1 })] = 'keep'; }
      });
      this.prunePage(this.heap, pg, h, steps);
    }
    const deadLps = [];
    this.heap.pages.forEach(pg => pg.lps.forEach((lp, i) => { if (lp.state === 'dead') deadLps.push({ p: pg.id, lp: i + 1 }); }));
    const deadKeys = new Set(deadLps.map(tidKey));
    let idxRemoved = 0;
    if (deadLps.length) steps.push({ text: `pass 2: remove index entries pointing at ${deadLps.length} dead line pointer${deadLps.length > 1 ? 's' : ''}`, head: true });
    for (const idx of Object.values(this.indexes)) {
      const before = idx.entries.length;
      const nLeaves = this.indexLeaves(idx).length;
      if (deadLps.length) for (let b = 0; b <= nLeaves; b++) this.bufAccess(idx.name, b, null);
      idx.entries = idx.entries.filter(e => !deadKeys.has(tidKey(e.tid)));
      const n = before - idx.entries.length; idxRemoved += n;
      if (n) { steps.push({ text: `index ${idx.name}: removed ${n} entr${n === 1 ? 'y' : 'ies'}`, sub: true }); for (let b = 0; b <= nLeaves; b++) this.markDirtyKey(idx.name + '/' + b, null); }
    }
    if (deadLps.length) steps.push({ text: `pass 3: dead line pointers → unused. Only now is it safe: no index entry can still point at them.`, head: true });
    for (const t of deadLps) { this.heap.pages[t.p].lps[t.lp - 1] = { state: 'unused' }; this.markDirtyKey(TABLE + '/' + t.p, null); steps.push({ text: `${tidStr(t)} → unused`, sub: true, verdict: 'removed' }); }
    // TOAST table
    let toastFreed = 0;
    if (this.toast.pages.length) {
      steps.push({ text: `vacuum ${TOAST_REL}`, head: true });
      for (const pg of this.toast.pages) {
        this.bufAccess(TOAST_REL, pg.id, steps);
        pg.lps.forEach((lp, i) => {
          if (lp.state === 'normal' && this.deadToAll(lp.tuple, h)) { pg.lps[i] = { state: 'unused' }; toastFreed++; this.markDirtyKey(TOAST_REL + '/' + pg.id, null); steps.push({ text: `${TOAST_REL} ${tidStr({ p: pg.id, lp: i + 1 })}: chunk ${lp.tuple.data.chunk_id}/${lp.tuple.data.chunk_seq} removed`, sub: true, verdict: 'removed' }); }
        });
      }
      if (!toastFreed) steps.push({ text: 'no dead chunks', sub: true });
    }
    for (const pg of this.heap.pages) pg.lps.forEach(lp => { if (lp.state === 'normal') { this.xidStatusWithHints(lp.tuple, 'xmin', null, true); if (lp.tuple.xmax) this.xidStatusWithHints(lp.tuple, 'xmax', null, true); } });
    const nowVisible = [];
    for (const pg of this.heap.pages) {
      const ok = pg.lps.every(lp => lp.state === 'unused' || lp.state === 'redirect' || (lp.state === 'normal' && this.status(lp.tuple.xmin) === 'committed' && lp.tuple.xmin < h && (!lp.tuple.xmax || this.status(lp.tuple.xmax) === 'aborted')));
      if (ok && !pg.allVisible) { pg.allVisible = true; nowVisible.push(pg.id); this.markDirtyKey(TABLE + '/' + pg.id, null); }
      if (!ok) pg.allVisible = false;
    }
    if (nowVisible.length) steps.push({ text: `visibility map: marked page${nowVisible.length > 1 ? 's' : ''} ${nowVisible.join(', ')} all-visible (every tuple on ${nowVisible.length > 1 ? 'them' : 'it'} is visible to every transaction)`, verdict: 'vm' });
    if (!deadLps.length && !toastFreed && !kept) steps.push({ text: 'nothing to clean' });
    return { type: 'ok', text: `VACUUM: freed ${deadLps.length} line pointer${deadLps.length === 1 ? '' : 's'}, ${idxRemoved} index entr${idxRemoved === 1 ? 'y' : 'ies'}, ${toastFreed} TOAST chunk${toastFreed === 1 ? '' : 's'}; kept ${kept} recently dead` };
  }

  lensSnapshot(sess) { const iso = sess.inTx ? sess.txIso : sess.iso; if (sess.inTx && iso === 'REPEATABLE READ' && sess.snapshot) return sess.snapshot; return this.takeSnapshot(sess); }

  diskBlocks() {
    const out = [{ rel: TABLE, n: this.heap.pages.length }];
    for (const idx of Object.values(this.indexes)) out.push({ rel: idx.name, n: this.indexLeaves(idx).length + 1, isIdx: true });
    if (this.toast.pages.length) { out.push({ rel: TOAST_REL, n: this.toast.pages.length }); out.push({ rel: TOAST_IDX, n: 1, isIdx: true }); }
    return out;
  }
}

// ---------- helpers ----------
function varlena(s) { return s.length <= 126 ? s.length + 1 : s.length + 4; }
function estimateCompressed(s) {
  const n = s.length;
  if (n < 32) return null;
  for (let p = 1; p <= 64 && p * 2 <= n; p++) {
    let ok = true;
    for (let i = p; i < n; i++) if (s.charCodeAt(i) !== s.charCodeAt(i - p)) { ok = false; break; }
    if (ok) return p + 3 * Math.ceil(n / 273) + 4;
  }
  return null;
}
let _rng = 12345;
function rnd() { _rng |= 0; _rng = (_rng + 0x6D2B79F5) | 0; let t = Math.imul(_rng ^ (_rng >>> 15), 1 | _rng); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function randomText(n) {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let s = ''; for (let i = 0; i < n; i++) s += a[(rnd() * 64) | 0];
  return s;
}
function parseLiteral(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^repeat\s*\(\s*'(.*)'\s*,\s*(\d+)\s*\)$/i))) {
    const out = m[1].repeat(Number(m[2]));
    if (out.length > 100000) throw new SimError('value too large for this lab (max 100,000 characters)');
    return out;
  }
  if ((m = s.match(/^random_text\s*\(\s*(\d+)\s*\)$/i))) {
    const n = Number(m[1]); if (n > 100000) throw new SimError('value too large for this lab (max 100,000 characters)');
    return randomText(n);
  }
  if ((m = s.match(/^'(.*)'$/))) return m[1];
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^null$/i.test(s)) return null;
  throw new SimError(`could not read value ${s}`, { hint: "Quote text with single quotes: 'alice'. For long text use repeat('ab', 3000) or random_text(5000)." });
}
function splitTop(s) {
  const out = []; let cur = '', q = false, d = 0;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (ch === ',' && !q && d === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function evalExpr(expr, data) {
  const m = expr.match(/^(\w+)\s*([+\-*])\s*(-?\d+)$/);
  if (m && COLS.includes(m[1].toLowerCase())) {
    const a = Number(data[m[1].toLowerCase()]), b = Number(m[3]);
    return m[2] === '+' ? a + b : m[2] === '-' ? a - b : a * b;
  }
  if (COLS.includes(expr.toLowerCase())) return data[expr.toLowerCase()];
  return parseLiteral(expr);
}
function cmpKey(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; }
function cmp(a, b) {
  if (a === b) return 0;
  if (a == null) return 1; if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}
function fmtVal(v) { return v == null ? 'NULL' : typeof v === 'string' ? `'${v.length > 24 ? v.slice(0, 12) + '…' : v}'` : String(v); }
function fmtNotes(v) { return v == null ? null : v.length > 24 ? `${v.slice(0, 14)}… (${v.length} chars)` : v; }
function fmtRow(d) { return `{${d.id}, ${fmtVal(d.name)}, ${d.balance}${d.notes != null ? ', notes ' + d.notes.length + ' chars' : ''}}`; }

if (typeof module !== 'undefined') module.exports = { MiniPG, tidStr };
