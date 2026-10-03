'use strict';
/* Ritual Log — one fund of mini rituals for the week, built on the Mini Rituals
   model. Vocabulary from docs/CONTEXT.md; product copy is English.

   The model
   ---------
   Every ritual is a concrete per-day instance: "Mon Read", "Fri Read",
   "Fri Work A · iCare — merge #56". There is one fund of them — the week — and
   a day is only the slice that belongs to that weekday. No ritual wraps a whole
   day any more: the day is a list of small rituals. Each carries a single step
   today; the step list is data, so a ritual can grow into a sequence later.

   Finishing a ritual posts one line to #schedule through the webhook, so the
   channel hears about it the moment it happens (queued offline, retried until it
   lands). The log itself is shared across devices through one private gist — no
   server, no database.

   Data
   ----
   localStorage is the device store; the shared document carries only runs and
   extras, and per-run and per-step `ts` decides merges (newer wins, nothing is
   lost). The outbox is device-local by design: it is delivery state, not history. */

const GIST_ID = 'f5e0ab302e947c02675069113296131f';
const GIST_FILE = 'ritual-log.json';
const LS_DB = 'ritual-log.v3';
const LS_PLAN = 'ritual-log.plan.v3';
const LS_TOKEN = 'ritual-log.token';
/* Replaced with the commit sha at build time; `version.json` carries the same value,
   so an open tab can tell that it is running an older build and say so. */
const BUILD = '__BUILD__';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

const FALLBACK_PLAN = { updated: null, week: { iso: '', label: '', start: null, end: null }, rituals: [], days: {}, goals: [], anchors: [] };

const S = { plan: FALLBACK_PLAN, db: null, byId: {}, tab: 'today', ritualId: null, tick: null,
  planError: null, sync: 'local', syncMsg: '', dirty: false, pushing: false };

/* ---------- store ---------- */
function loadDB() {
  try { const raw = localStorage.getItem(LS_DB); if (raw) return JSON.parse(raw); } catch (e) {}
  return { v: 3, runs: {}, extras: {}, outbox: [], settings: { slide: true, sound: true, notify: true } };
}
function save() { S.db.updated = Date.now(); try { localStorage.setItem(LS_DB, JSON.stringify(S.db)); } catch (e) {} }
function loadPlanCache() {
  try { const raw = localStorage.getItem(LS_PLAN); if (raw) { const p = JSON.parse(raw); if (p && p.rituals && p.rituals.length) return p; } } catch (e) {}
  return null;
}
function token() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; } }

async function refreshPlan() {
  try {
    const res = await fetch('plan.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) { S.planError = 'HTTP ' + res.status; renderAll(); return; }
    const p = await res.json();
    if (!p || !p.rituals || !p.rituals.length) { S.planError = 'plan.json has no rituals'; renderAll(); return; }
    adoptPlan(p);
    try { localStorage.setItem(LS_PLAN, JSON.stringify(p)); } catch (e) { S.planError = 'could not cache the plan'; }
    renderAll();
  } catch (e) { S.planError = (e && e.message) ? e.message : String(e); renderAll(); }
}
function adoptPlan(p) {
  S.plan = p; S.planError = null;
  S.byId = {};
  (p.rituals || []).forEach(r => { S.byId[r.id] = r; });
}

/* ---------- sync: one private gist is the whole backend ---------- */
function setSync(state, msg) { S.sync = state; S.syncMsg = msg || ''; renderChips(); }
function markDirty() { S.dirty = true; schedulePush(); }
let pushTimer = null;
function schedulePush(delay) {
  if (!token()) { setSync('local', 'Not connected — this device only'); return; }
  setSync('pending', 'Saving…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, delay == null ? 2500 : delay);
}
function sharedDoc(db) { return { v: 3, updatedAt: db.updated || 0, runs: db.runs || {}, extras: db.extras || {} }; }

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, Object.assign({}, opts, {
    cache: 'no-store',
    headers: Object.assign({ Authorization: 'token ' + token(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, opts.headers || {})
  }));
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}
const EMPTY_DOC = () => ({ v: 3, runs: {}, extras: {} });
function parseDoc(file) { try { return file && file.content ? JSON.parse(file.content) : EMPTY_DOC(); } catch (e) { return EMPTY_DOC(); } }
async function pull() {
  if (!token()) { setSync('local', 'Not connected — this device only'); return; }
  setSync('syncing', 'Checking the shared log…');
  try {
    const g = await gh('/gists/' + GIST_ID);
    const merged = mergeDocs(sharedDoc(S.db), parseDoc(g.files && g.files[GIST_FILE]));
    S.db.runs = merged.runs; S.db.extras = merged.extras || {};
    save(); renderAll();
    setSync('synced', 'Updated ' + D.hhmm(Date.now()));
    if (S.dirty) push();
  } catch (e) {
    setSync('failed', rejected(e) ? 'Token rejected — check it has gist access' : 'Could not reach the shared log (' + e.message + ')');
  }
}
async function push() {
  if (!token() || S.pushing) return;
  S.pushing = true;
  setSync('syncing', 'Saving…');
  try {
    const g = await gh('/gists/' + GIST_ID);
    const merged = mergeDocs(sharedDoc(S.db), parseDoc(g.files && g.files[GIST_FILE]));
    S.db.runs = merged.runs; S.db.extras = merged.extras || {};
    merged.updatedAt = Date.now(); save();
    await gh('/gists/' + GIST_ID, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(merged) } } }) });
    S.dirty = false; renderAll();
    setSync('synced', 'Saved ' + D.hhmm(Date.now()));
  } catch (e) {
    setSync('failed', rejected(e) ? 'Token rejected — check it has gist access' : 'Not saved (' + e.message + ')');
  }
  S.pushing = false;
}
function rejected(e) { return e && (e.status === 401 || e.status === 403); }

/* Newer `ts` wins per run and per step, so both devices can write. */
function mergeDocs(a, b) {
  const out = { v: 3, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0), runs: {}, extras: {} };
  const keys = new Set(Object.keys(a.runs || {}).concat(Object.keys(b.runs || {})));
  keys.forEach(k => {
    const x = (a.runs || {})[k], y = (b.runs || {})[k];
    if (!x) { out.runs[k] = y; return; }
    if (!y) { out.runs[k] = x; return; }
    const run = ts(x) >= ts(y) ? Object.assign({}, x) : Object.assign({}, y);
    run.steps = {};
    new Set(Object.keys(x.steps || {}).concat(Object.keys(y.steps || {}))).forEach(id => {
      const sx = (x.steps || {})[id], sy = (y.steps || {})[id];
      if (!sx) run.steps[id] = sy;
      else if (!sy) run.steps[id] = sx;
      else run.steps[id] = ts(sx) >= ts(sy) ? sx : sy;
    });
    run.startedAt = minDefined(x.startedAt, y.startedAt);
    run.endedAt = maxDefined(x.endedAt, y.endedAt);
    if (x.status === 'completed' || y.status === 'completed') run.status = 'completed';
    out.runs[k] = run;
  });
  const dates = new Set(Object.keys(a.extras || {}).concat(Object.keys(b.extras || {})));
  dates.forEach(d => {
    const seen = {};
    ((a.extras || {})[d] || []).concat((b.extras || {})[d] || []).forEach(x => { if (x && x.at != null) seen[x.at + '|' + (x.text || '')] = x; });
    if (Object.keys(seen).length) out.extras[d] = Object.values(seen).sort((p, q) => p.at - q.at);
  });
  return out;
}
function ts(r) { return (r && (r.ts || r.completedAt || r.endedAt || r.startedAt)) || 0; }
function minDefined(a, b) { const v = [a, b].filter(n => n != null); return v.length ? Math.min.apply(null, v) : null; }
function maxDefined(a, b) { const v = [a, b].filter(n => n != null); return v.length ? Math.max.apply(null, v) : null; }

/* ---------- outbox: one line to #schedule per finished ritual ---------- */
function notify(text) {
  if (!S.db.settings.notify) return;
  S.db.outbox.push({ text, at: Date.now(), tries: 0 });
  save();
  flushOutbox();
}
let flushing = false;
async function flushOutbox() {
  if (!window.__WEBHOOK__ || flushing || !S.db.outbox.length) { renderChips(); return; }
  flushing = true;
  while (S.db.outbox.length) {
    const item = S.db.outbox[0];
    try {
      const r = await fetch(window.__WEBHOOK__, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: item.text, username: 'Ritual Log' }) });
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      S.db.outbox.shift(); save(); renderChips();
      await new Promise(res => setTimeout(res, 350));
    } catch (err) {
      item.tries = (item.tries || 0) + 1; save();
      if (item.tries > 3) setSync(S.sync, 'Could not reach #schedule — will retry');
      break;                                   /* keep the queue; retry on the next tick */
    }
  }
  flushing = false; renderChips(); renderSummary();
}

/* ---------- dates ---------- */
const TZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const D = {
  key(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  hhmm(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
  short(d = new Date()) {
    return d.toLocaleDateString('en-GB', { weekday: 'short' }).replace(/[.,]/g, '') + ' ' +
      d.toLocaleDateString('en-GB', { day: '2-digit' }) + ' ' +
      d.toLocaleDateString('en-GB', { month: 'short' }).replace(/[.,]/g, '');
  },
  isoWeek(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    return y + '-W' + String(Math.ceil(((t - new Date(Date.UTC(y, 0, 1))) / 864e5 + 1) / 7)).padStart(2, '0');
  },
  today() { return D.key(new Date()); },
  weekdayCode(d = new Date()) { return DAYS[(d.getDay() + 6) % 7]; },
  /* the date of a weekday inside the current week (Mon-based) */
  dateOfWeekday(code) {
    const now = new Date();
    const diff = DAYS.indexOf(code) - DAYS.indexOf(D.weekdayCode(now));
    return D.key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff));
  }
};
function dur(min) {
  min = Math.max(0, Math.round(min));
  return min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'm';
}
/* live elapsed under a minute reads in seconds — a run in progress should never
   look like it has done nothing */
function durLive(sec) { return sec < 60 ? Math.round(sec) + 's' : dur(sec / 60); }
/* a running timer reads as a clock (1:07) so it visibly moves every second */
function timerText(sec) {
  const s = Math.floor(sec);
  if (s < 3600) return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  return dur(s / 60);
}
function planMinutes(ritual) {
  if (ritual.minutes != null) return ritual.minutes;
  if (ritual.start && ritual.end) {
    const p = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    return Math.max(0, p(ritual.end) - p(ritual.start));
  }
  return null;
}

/* ---------- rituals and runs ---------- */
function ritualsOfDay(code) { return (S.plan.rituals || []).filter(r => r.day === code).sort((a, b) => a.order - b.order); }
function anyDayRituals() { return (S.plan.rituals || []).filter(r => !r.day); }
function scopeOf(ritual) { return ritual.day ? D.dateOfWeekday(ritual.day) : D.isoWeek(); }
function runKeyOf(ritual) { return ritual.id + ':' + scopeOf(ritual); }
function getRunFor(ritual, create = true) {
  const key = runKeyOf(ritual);
  let run = S.db.runs[key];
  if (!run && create) {
    run = S.db.runs[key] = { key, ritual: ritual.id, scope: scopeOf(ritual), revision: S.plan.updated || null,
      startedAt: null, endedAt: null, status: 'active', steps: {}, ts: Date.now() };
    save();
  }
  return run;
}
/* A run is created when execution begins, not when a ritual is viewed. */
function viewRun(ritual) {
  return getRunFor(ritual, false) || { key: runKeyOf(ritual), ritual: ritual.id, scope: scopeOf(ritual),
    revision: S.plan.updated || null, startedAt: null, endedAt: null, status: 'not started', steps: {} };
}
function stepStatus(run, id) { const s = run.steps[id]; return s ? s.status : 'pending'; }
function stepElapsed(run, id) {
  const s = run.steps[id]; if (!s) return 0;
  let sec = s.seconds || 0;
  if (s.status === 'active' && s.startedAt) sec += (Date.now() - s.startedAt) / 1000;
  return sec;
}
function activeStepId(run) { for (const id in run.steps) if (run.steps[id].status === 'active') return id; return null; }
function activeAnywhere() {
  for (const k in S.db.runs) {
    const r = S.db.runs[k];
    if (r.status === 'active' && activeStepId(r)) return r.ritual;
  }
  return null;
}
function ritualState(ritual) {
  const run = getRunFor(ritual, false);
  const steps = ritual.steps || [];
  if (!run || !steps.length) return 'pending';
  const st = steps.map(s => stepStatus(run, s.id));
  if (st.every(x => x === 'completed')) return 'completed';
  if (st.every(x => x === 'completed' || x === 'skipped')) return 'skipped';
  if (st.some(x => x === 'active')) return 'active';
  return 'pending';
}
function ritualDone(ritual) { const s = ritualState(ritual); return s === 'completed' || s === 'skipped'; }
function ritualRunMinutes(ritual) {
  const run = getRunFor(ritual, false); if (!run) return 0;
  let el = 0;
  (ritual.steps || []).forEach(s => { el += stepElapsed(run, s.id); });
  return el / 60;
}
function dayIsPast(code) { return DAYS.indexOf(code) < DAYS.indexOf(D.weekdayCode()); }
function todayRituals() { return ritualsOfDay(D.weekdayCode()); }
function todayComplete() { const l = todayRituals(); return l.length > 0 && l.every(ritualDone); }
function dayProgress(code) { const l = ritualsOfDay(code); return { done: l.filter(ritualDone).length, n: l.length }; }
function workMinutes(list) { return list.filter(r => r.kind === 'work').reduce((a, r) => a + ritualRunMinutes(r), 0); }
function weekProgress() {
  const l = S.plan.rituals || [];
  return { done: l.filter(ritualDone).length, n: l.length, work: workMinutes(l) };
}

/* ---------- mutations ---------- */
function startStep(ritual, id) {
  const run = getRunFor(ritual);
  const now = Date.now();
  const cur = activeStepId(run);
  if (cur === id) return;
  if (cur) { const c = run.steps[cur]; c.seconds = (c.seconds || 0) + (now - c.startedAt) / 1000; c.status = 'pending'; c.startedAt = null; c.ts = now; }
  const s = run.steps[id] || (run.steps[id] = { seconds: 0 });
  s.status = 'active'; s.startedAt = now; s.completedAt = null; s.skipped = false; s.ts = now;
  if (!run.startedAt) run.startedAt = now;
  run.status = 'active'; run.ts = now;
  save(); haptic('light'); markDirty(); renderAll();
}
function completeStep(ritual, id, skipped = false) {
  const run = getRunFor(ritual);
  const s = run.steps[id] || (run.steps[id] = { seconds: 0 });
  if (s.status === 'completed' || s.status === 'skipped') return;      /* completions are idempotent */
  const now = Date.now();
  const startedAt = s.startedAt;
  if (s.status === 'active' && s.startedAt) s.seconds = (s.seconds || 0) + (now - s.startedAt) / 1000;
  s.status = skipped ? 'skipped' : 'completed';
  s.skipped = skipped; s.completedAt = now; s.startedAt = null; s.ts = now;
  if (!run.startedAt) run.startedAt = now;
  const el = stepElapsed(run, id);
  const allDone = (ritual.steps || []).every(x => ['completed', 'skipped'].indexOf(stepStatus(run, x.id)) >= 0);
  if (allDone) { run.status = 'completed'; run.endedAt = now; run.ts = now; }
  haptic(skipped ? 'light' : 'medium');
  save(); markDirty();
  notify(completionLine(ritual, startedAt, skipped, el, planMinutes(ritual)));
  renderAll();
  /* One ritual earns a check bloom; the whole day earns the confetti and the
     bell — eleven rituals should not fire eleven parties. */
  if (allDone) {
    if (todayComplete()) { if (!run.celebrated) { run.celebrated = true; save(); completionMoment(true); } }
    else completionMoment(false);
  }
}
function completionLine(ritual, startedAt, skipped, elapsedSec, plan) {
  if (skipped) return '↷ ' + ritual.title + ' — skipped';
  const win = (startedAt ? D.hhmm(startedAt) + '–' : '') + D.hhmm(Date.now());
  const mins = elapsedSec / 60;
  const d = plan && mins > 20 ? ' (' + (mins - plan > 0 ? '+' : '') + Math.round(mins - plan) + 'm)' : (plan ? ' (plan ' + dur(plan) + ')' : '');
  return '✅ ' + ritual.title + ' · ' + win + ' · ' + durLive(elapsedSec) + d;
}
function reopenStep(ritual, id) {
  const run = getRunFor(ritual); const s = run.steps[id]; if (!s) return;
  s.status = 'pending'; s.skipped = false; s.completedAt = null; s.startedAt = null; s.ts = Date.now();
  if (run.status === 'completed') { run.status = 'active'; run.endedAt = null; run.ts = Date.now(); }
  save(); markDirty(); renderAll();
}
function pauseStep(ritual, id) {
  const run = getRunFor(ritual); const s = run.steps[id];
  if (s && s.status === 'active') {
    s.seconds = (s.seconds || 0) + (Date.now() - s.startedAt) / 1000; s.startedAt = null; s.status = 'pending'; s.ts = Date.now();
    save(); markDirty(); renderAll();
  }
}
function abandonRun(ritual) {
  const run = getRunFor(ritual); const cur = activeStepId(run);
  if (cur) { const c = run.steps[cur]; c.seconds = (c.seconds || 0) + (Date.now() - c.startedAt) / 1000; c.startedAt = null; c.status = 'pending'; c.ts = Date.now(); }
  run.status = 'abandoned'; run.endedAt = Date.now(); run.ts = Date.now();
  save(); markDirty(); renderAll(); toast('Run abandoned — kept in history');
}
function addExtra(dateKey, text, minutes) {
  const list = S.db.extras[dateKey] || (S.db.extras[dateKey] = []);
  list.push({ text, minutes: minutes || null, at: Date.now() });
  save(); markDirty(); renderAll();
}
function removeExtra(dateKey, i) {
  const list = S.db.extras[dateKey] || []; list.splice(i, 1); S.db.extras[dateKey] = list;
  save(); markDirty(); renderAll();
}

/* ---------- feedback ---------- */
function haptic(kind) {
  if (!navigator.vibrate) return;
  try { navigator.vibrate(kind === 'medium' ? [18, 40, 24] : 12); } catch (e) {}
}
let audioCtx = null;
function bell() {
  if (!S.db.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * .13);
      g.gain.linearRampToValueAtTime(.16, t + i * .13 + .02);
      g.gain.exponentialRampToValueAtTime(.0008, t + i * .13 + .85);
      o.connect(g); g.connect(audioCtx.destination); o.start(t + i * .13); o.stop(t + i * .13 + .9);
    });
  } catch (e) {}
}
function completionMoment(full) {
  const el = document.getElementById('moment');
  el.classList.toggle('small', !full);
  el.classList.add('on'); haptic('medium');
  if (full) {
    bell();
    const colors = ['#C2410C', '#FB923C', '#15803D', '#4ADE80', '#A8A29E'];
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (let i = 0; i < 26; i++) {
        const p = document.createElement('i');
        p.className = 'confetti';
        p.style.background = colors[i % colors.length];
        p.style.left = (12 + Math.random() * 76) + 'vw'; p.style.top = '-12px';
        p.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
        document.body.appendChild(p);
        const dx = (Math.random() - .5) * 160, dy = window.innerHeight * (.55 + Math.random() * .45), rot = Math.random() * 720;
        p.animate([{ transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
                   { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(' + rot + 'deg)', opacity: 0 }],
                  { duration: 1500 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => p.remove();
      }
    }
  }
  setTimeout(() => el.classList.remove('on'), full ? 1500 : 750);
}
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}
function copyText(text, okMsg) {
  const done = () => toast(okMsg || 'Copied');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy'); }
  ta.remove();
}

/* ---------- render ---------- */
function renderAll() { renderHeader(); renderToday(); renderWeek(); renderRitual(); renderSummary(); renderChips(); }

function renderHeader() {
  document.getElementById('clock').textContent = D.hhmm(Date.now());
  document.getElementById('dateline').textContent = D.short();
  document.getElementById('datesub').textContent =
    (S.plan.week && S.plan.week.iso ? S.plan.week.iso : D.isoWeek()) + ' · ' + TZ();
}

function statusDot(state, past) {
  if (state === 'completed') return '<span class="dot ok"></span>';
  if (state === 'skipped') return '<span class="dot skip"></span>';
  if (state === 'active') return '<span class="dot live"></span>';
  return '<span class="dot' + (past ? ' miss' : '') + '"></span>';
}
function statusBadge(ritual, state) {
  if (state === 'completed') return '<span class="badge ok">done</span>';
  if (state === 'skipped') return '<span class="badge n">skipped</span>';
  const run = getRunFor(ritual, false);
  if (state === 'active' && run) return '<span class="badge a live tnum">' + timerText(stepElapsed(run, activeStepId(run))) + '</span>';
  const plan = planMinutes(ritual);
  if (!plan) return '';                       /* a chore inside a block has no plan of its own */
  return '<span class="badge n tnum">' + dur(plan) + '</span>';
}
function ritualRow(ritual) {
  const state = ritualState(ritual);
  const run = getRunFor(ritual, false);
  const past = ritual.day ? dayIsPast(ritual.day) && state === 'pending' : false;
  const el = ritualRunMinutes(ritual);
  const plan = planMinutes(ritual);
  const sub = [
    ritual.block ? ritual.block + (ritual.block_window ? ' · ' + ritual.block_window : '') : null,
    ritual.start ? 'plan ' + ritual.start + (ritual.end ? '–' + ritual.end : '') : null,
    el >= 1 ? dur(el) + (plan && state === 'completed' ? ' / ' + dur(plan) : '') : null,
    run && run.startedAt && state === 'active' ? 'since ' + D.hhmm(run.startedAt) : null,
    past ? 'missed' : null
  ].filter(Boolean).join(' · ');
  return '<button class="row-ritual' + (state === 'completed' || state === 'skipped' ? ' done' : '') + '" data-open-ritual="' + ritual.id + '">' +
    statusDot(state, past) +
    '<span class="body"><span class="t">' + esc(ritual.title) + '</span>' + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</span>' +
    statusBadge(ritual, state) + '</button>';
}
function sectionHead(label, right) {
  return '<div class="dayhead"><span>' + esc(label) + '</span><span class="tnum">' + esc(right || '') + '</span></div>';
}

function renderToday() {
  const code = D.weekdayCode();
  const list = ritualsOfDay(code);
  const p = dayProgress(code);
  const anchors = ((S.plan.days || {})[D.today()] || {}).anchors || [];
  let html = anchors.length ? '<div class="banner"><b>Today:</b> ' + anchors.map(esc).join(' · ') + '</div>' : '';
  if (S.planError || !S.plan.updated) html += '<div class="banner"><b>Plan not loaded</b>' + (S.planError ? ' (' + esc(S.planError) + ')' : '') + '.</div>';
  document.getElementById('today-banner').innerHTML = html;

  document.getElementById('today-head').innerHTML =
    '<span class="k">' + DAY_LABEL[code] + ' rituals</span><span class="spacer"></span>' +
    '<span class="badge ' + (p.n && p.done === p.n ? 'ok' : 'n') + ' tnum">' + p.done + '/' + p.n + '</span>';

  document.getElementById('today-list').innerHTML = list.length
    ? list.map(ritualRow).join('')
    : '<div class="empty">Sunday is a free day — nothing is scheduled. The "any day this week" rituals live on the Week tab.</div>';

  const extras = S.db.extras[D.today()] || [];
  document.getElementById('extras').innerHTML = extras.length
    ? '<ul class="plain">' + extras.map((x, i) => '<li><span>' + esc(x.text) + '</span><span class="sp tnum">' + D.hhmm(x.at) +
        (x.minutes ? ' · ' + dur(x.minutes) : '') + '</span><button class="b sm ghost" data-xdel="' + i + '">×</button></li>').join('') + '</ul>'
    : '<div class="micro muted">Nothing extra logged today.</div>';

  document.getElementById('goals').innerHTML = (S.plan.goals || []).map(g =>
    '<div class="goal"><div class="gh"><span class="k">' + esc(g.project) + '</span>' +
      (g.status ? '<span class="badge ' + (g.status === 'at_risk' ? 'warn' : 'ok') + '">' + (g.status === 'at_risk' ? 'at risk' : 'on track') + '</span>' : '') +
      (g.headline ? '<span class="micro muted">' + esc(g.headline) + '</span>' : '') +
    '</div><div class="small">' + esc(g.detail || '') + '</div></div>').join('') ||
    '<div class="empty">The week goals arrive with the week plan.</div>';
}

function renderWeek() {
  const w = weekProgress();
  document.getElementById('week-head').innerHTML =
    '<span class="k">' + esc((S.plan.week && S.plan.week.label) || 'This week') + '</span><span class="spacer"></span>' +
    '<span class="badge ' + (w.n && w.done === w.n ? 'ok' : 'n') + ' tnum">' + w.done + '/' + w.n + '</span>';
  let html = '';
  DAYS.slice(0, 6).forEach(code => {
    const list = ritualsOfDay(code); if (!list.length) return;
    const p = dayProgress(code);
    html += sectionHead(DAY_LABEL[code], p.done + '/' + p.n) + list.map(ritualRow).join('');
  });
  const any = anyDayRituals();
  if (any.length) html += sectionHead('Any day this week', any.filter(ritualDone).length + '/' + any.length) + any.map(ritualRow).join('');
  document.getElementById('week-list').innerHTML = html || '<div class="empty">No rituals in the plan yet.</div>';
}

function renderRitual() {
  const ritual = S.byId[S.ritualId];
  const kicker = document.getElementById('rv-kicker');
  if (!ritual) {
    document.getElementById('rv-nav').innerHTML = '';
    kicker.textContent = 'Ritual';
    document.getElementById('rv-title').textContent = 'Pick a ritual';
    document.getElementById('rv-sub').textContent = '';
    document.getElementById('rv-pct').textContent = '—';
    document.getElementById('rv-state').textContent = '';
    document.getElementById('rv-state').className = 'badge n';
    document.getElementById('steps').innerHTML = '';
    document.getElementById('steps-empty').hidden = false;
    document.getElementById('steps-empty').textContent = 'Open one from Today or Week.';
    document.getElementById('rv-tools').innerHTML = '';
    return;
  }
  const run = viewRun(ritual);
  const steps = ritual.steps || [];
  const state = ritualState(ritual);
  const doneSteps = steps.filter(s => ['completed', 'skipped'].indexOf(stepStatus(run, s.id)) >= 0).length;
  document.getElementById('rv-nav').innerHTML =
    '<button class="b sm ghost" data-tab="today">Today</button><button class="b sm ghost" data-tab="week">Week</button>';
  kicker.textContent = ritual.day ? DAY_LABEL[ritual.day] + ' ritual · ' + scopeOf(ritual) : 'Any day this week · ' + D.isoWeek();
  document.getElementById('rv-title').textContent = ritual.title;
  document.getElementById('rv-pct').textContent = (steps.length ? Math.round((doneSteps / steps.length) * 100) : 0) + '%';
  document.getElementById('rv-state').textContent = state === 'active' ? 'active run' : state;
  document.getElementById('rv-state').className = 'badge ' + (state === 'active' ? 'a' : state === 'completed' ? 'ok' : 'n');
  document.getElementById('rv-sub').textContent = [
    ritual.block ? 'in ' + ritual.block + (ritual.block_window ? ' · ' + ritual.block_window : '') : null,
    planMinutes(ritual) ? 'plan ' + dur(planMinutes(ritual)) + (ritual.start ? ' · ' + ritual.start + (ritual.end ? '–' + ritual.end : '') : '') : '',
    steps.length + (steps.length === 1 ? ' step' : ' steps'),
    run.startedAt ? 'since ' + D.hhmm(run.startedAt) : 'not started'
  ].filter(Boolean).join(' · ');

  document.getElementById('steps-empty').hidden = steps.length > 0;
  document.getElementById('steps').innerHTML = steps.map((st, i) => stepRow(ritual, run, st, i)).join('');
  wireSlides(ritual);

  document.getElementById('rv-tools').innerHTML =
    (run.status === 'active' && !activeStepId(run) ? '<button class="b sm ghost" id="rv-abandon">Abandon run</button>' : '') +
    (steps.length && state !== 'completed' && state !== 'skipped' ? '<button class="b sm ghost" id="rv-done">Close the run</button>' : '');
}

function stepRow(ritual, run, st, i) {
  const s = run.steps[st.id] || {};
  const status = s.status || 'pending';
  const plan = planMinutes(ritual);
  const el = stepElapsed(run, st.id);
  const over = plan && status === 'active' && el / 60 > plan;
  const actual = (s.completedAt || s.startedAt)
    ? [s.startedAt ? D.hhmm(s.startedAt) : null, s.completedAt ? D.hhmm(s.completedAt) : 'now'].filter(Boolean).join('–') : null;

  let head = '';
  if (status === 'completed') head = '<span class="badge ok">done</span>';
  else if (status === 'skipped') head = '<span class="badge n">skipped</span>';
  else if (status === 'active') head = '<span class="badge ' + (over ? 'warn' : 'a') + ' live tnum">' + timerText(el) + '</span>';
  else head = '<span class="badge n tnum">' + (plan ? dur(plan) : '—') + '</span>';

  const sub = [actual, st.optional ? 'optional' : null].filter(Boolean).join(' · ');
  const prog = status === 'active'
    ? '<div class="prog"><span class="bar"><i style="width:' + Math.min(100, plan ? (el / 60 / plan) * 100 : 0) + '%"></i></span>' +
      '<span class="micro muted tnum">' + timerText(el) + (plan ? ' / ' + dur(plan) : '') + '</span></div>'
    : '';

  const acts = [];
  if (status === 'pending') acts.push('<button class="b sm" data-start="' + st.id + '">Start timer</button>');
  if (status === 'active') acts.push('<button class="b sm" data-pause="' + st.id + '">Pause timer</button>');
  acts.push('<button class="b sm ghost" data-skip="' + st.id + '">' + (status === 'completed' || status === 'skipped' ? 'Reopen' : 'Skip') + '</button>');

  const slide = (status === 'completed' || status === 'skipped') ? '' :
    '<div class="slide' + (S.db.settings.slide ? '' : ' tapmode') + '" data-slide="' + st.id + '">' +
      '<div class="fill"></div><div class="hint">' + (S.db.settings.slide ? 'Slide to complete' : 'Tap to complete') + '</div>' +
      (S.db.settings.slide ? '<div class="knob" role="slider" tabindex="0" aria-label="Slide to complete ' + esc(st.title) + '">→</div>' : '') +
    '</div>';
  const alt = (status === 'completed' || status === 'skipped') ? '' : '<button class="b sm" data-alt="' + st.id + '">Complete</button>';

  return '<li class="step ' + status + '" data-step="' + st.id + '">' +
    '<div class="sr"><span class="idx tnum">' + (i + 1) + '</span><span class="body">' +
    '<div class="t">' + esc(st.title) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + prog +
    '</span><span class="state">' + head + '</span></div>' +
    slide + '<div class="step-acts">' + acts.join('') + alt + '</div></li>';
}

/* slide to complete — full-width drag, committing past the threshold. The same
   commit is always available as a plain button, and the setting turns the track
   into a tap target for anyone who would rather not drag. */
function wireSlides(ritual) {
  document.querySelectorAll('[data-slide]').forEach(el => {
    const id = el.dataset.slide;
    const knob = el.querySelector('.knob');
    const fill = el.querySelector('.fill');
    const max = () => el.clientWidth - 52;
    let dragging = false, x0 = 0, dx = 0;

    const paint = () => {
      const p = Math.max(0, Math.min(1, dx / max()));
      if (knob) knob.style.transform = 'translateX(' + p * max() + 'px)';
      fill.style.width = (p * 100) + '%';
      el.classList.toggle('armed', p > .92);
    };
    const reset = () => { dx = 0; if (knob) knob.style.transform = ''; fill.style.width = '0'; el.classList.remove('armed'); };

    if (S.db.settings.slide && knob) {
      const down = e => { dragging = true; x0 = (e.touches ? e.touches[0].clientX : e.clientX);
        try { if (knob.setPointerCapture && e.pointerId != null) knob.setPointerCapture(e.pointerId); } catch (err) {} };
      const move = e => { if (!dragging) return; const x = (e.touches ? e.touches[0].clientX : e.clientX); dx = Math.max(0, x - x0); paint(); if (e.cancelable) e.preventDefault(); };
      const up = () => { if (!dragging) return; dragging = false; if (dx / max() > .65) completeStep(ritual, id); else reset(); };
      knob.addEventListener('pointerdown', down); knob.addEventListener('pointermove', move);
      knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
      knob.addEventListener('touchstart', down, { passive: true });
      knob.addEventListener('touchmove', move, { passive: false });
      knob.addEventListener('touchend', up);
      knob.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); completeStep(ritual, id); } });
    } else {
      el.addEventListener('click', () => completeStep(ritual, id));
    }
  });
}

function renderSummary() {
  const list = todayRituals();
  const p = dayProgress(D.weekdayCode());
  const w = weekProgress();
  const rows = [
    ['Today', p.done + '/' + p.n + ' rituals'],
    ['Work today', workMinutes(list) ? dur(workMinutes(list)) : '—'],
    ['Week', w.done + '/' + w.n + ' rituals'],
    ['Week work', w.work ? dur(w.work) : '—'],
    ['To send', S.db.outbox.length ? S.db.outbox.length + ' line(s) queued' : 'nothing waiting'],
    ['Shared log', S.sync === 'synced' ? 'up to date' : S.sync === 'local' ? 'this device only' : (S.syncMsg || S.sync)]
  ];
  document.getElementById('summary').innerHTML = rows.map(r =>
    '<div class="kv"><span class="k">' + r[0] + '</span><span class="v tnum">' + esc(r[1]) + '</span></div>').join('') +
    '<div class="micro muted" style="margin-top:10px">Plan revision: ' + esc(S.plan.updated || '—') + '</div>';

  const ta = document.getElementById('log-day');
  if (ta && document.activeElement !== ta) ta.value = dayLog();
  document.getElementById('send-day').hidden = !window.__WEBHOOK__;
  document.getElementById('send-note').textContent = window.__WEBHOOK__
    ? 'Every ritual you finish is already posted to #schedule on its own. This sends the whole day in one message.'
    : 'No webhook configured: use Copy and paste it into #schedule.';

  const hist = [];
  Object.keys(S.db.runs || {}).forEach(k => {
    const run = S.db.runs[k];
    const ritual = S.byId[run.ritual] || { title: run.ritual + ' (older revision)' };
    Object.keys(run.steps || {}).forEach(sid => {
      const s = run.steps[sid];
      if (!s.completedAt) return;
      hist.push({ at: s.completedAt, title: ritual.title, state: s.skipped ? 'skipped' : 'completed', sec: s.seconds || 0, scope: run.scope });
    });
  });
  hist.sort((a, b) => b.at - a.at);
  document.getElementById('history').innerHTML = hist.slice(0, 25).map(h =>
    '<li><span>' + esc(h.title) + '</span><span class="sp tnum">' + h.scope + ' · ' + D.hhmm(h.at) +
    ' · ' + (h.sec ? dur(h.sec / 60) : '—') + ' · ' + h.state + '</span></li>').join('');
  document.getElementById('history-empty').hidden = hist.length > 0;

  document.getElementById('settings').innerHTML =
    '<div class="toggle ' + (S.db.settings.slide ? 'on' : '') + '" data-set="slide"><span class="lbl">Slide to complete<small>Off: the track completes on a tap instead.</small></span><span class="sw"></span></div>' +
    '<div class="toggle ' + (S.db.settings.sound ? 'on' : '') + '" data-set="sound"><span class="lbl">Sound<small>One bell when the whole day is done.</small></span><span class="sw"></span></div>' +
    '<div class="toggle ' + (S.db.settings.notify ? 'on' : '') + '" data-set="notify"><span class="lbl">Post each completion to #schedule<small>One line per finished ritual, sent the moment it happens.</small></span><span class="sw"></span></div>';

  document.getElementById('state-info').textContent =
    'Plan ' + (S.plan.updated || '—') + ' · saved ' + (S.db.updated ? new Date(S.db.updated).toLocaleString('en-GB') : '—') +
    ' · ' + Object.keys(S.db.runs).length + ' runs · ' + (S.plan.rituals || []).length + ' rituals · build ' + BUILD;
}

const SYNC_LABEL = { local: 'this device', pending: 'saving', syncing: 'syncing', synced: 'synced', failed: 'not saved' };
const SYNC_CLASS = { local: 'n', pending: 'a', syncing: 'a', synced: 'ok', failed: 'warn' };
function renderChips() {
  if (!S.db) return;
  const chip = document.getElementById('sync-chip');
  const cls = SYNC_CLASS[S.sync] || 'n';
  chip.className = 'badge ' + cls;
  chip.textContent = SYNC_LABEL[S.sync] || S.sync;
  chip.title = S.syncMsg || '';
  const queued = S.db.outbox.length;
  const q = document.getElementById('queue-chip');
  q.hidden = queued === 0;
  q.textContent = queued + ' to send';
  q.title = 'Completion lines waiting to reach #schedule';
  const card = document.getElementById('sync-card');
  if (!card) return;
  const tok = token();
  card.innerHTML =
    '<div class="card-head"><span class="k">Shared log</span><span class="spacer"></span><span class="badge ' + cls + '">' + esc(chip.textContent) + '</span></div>' +
    '<div class="small muted" style="margin-bottom:10px">' + esc(S.syncMsg || (tok ? 'Connected.' : 'Not connected — runs stay on this device.')) +
      (queued ? ' · ' + queued + ' completion line(s) still to reach #schedule.' : '') + '</div>' +
    '<div class="row"><input type="password" id="tok" autocomplete="off" placeholder="GitHub token with gist access" value="' + (tok ? '••••••••••••••••' : '') + '"></div>' +
    '<div class="row">' +
      '<button class="b sm primary" id="tok-save">' + (tok ? 'Replace token' : 'Connect') + '</button>' +
      '<button class="b sm" id="sync-now">Sync now</button>' +
      (tok ? '<button class="b sm ghost" id="tok-clear">Disconnect</button>' : '') +
    '</div>' +
    '<div class="micro muted" style="margin-top:10px">One private gist holds the log; both devices read and write it. The token stays in this browser, needs only <b>gist</b> access and can be revoked whenever — ' +
    '<a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Ritual%20Log" target="_blank" rel="noopener">create one</a>. #schedule messages work without it.</div>';
}

/* ---------- the day's log, shaped for the channel ---------- */
function dayLog() {
  const code = D.weekdayCode();
  const list = ritualsOfDay(code);
  const p = dayProgress(code);
  const lines = ['**Ritual Log · ' + D.short() + '**'];
  lines.push(DAY_LABEL[code] + ' ' + p.done + '/' + p.n + ' rituals' + (workMinutes(list) ? ' · work ' + dur(workMinutes(list)) : ''));
  list.forEach(r => {
    const state = ritualState(r);
    const run = getRunFor(r, false);
    const key = run && Object.keys(run.steps)[0];
    const st = key ? run.steps[key] : null;
    if (state === 'completed') lines.push('- ✅ ' + r.title + (st && st.seconds ? ' — ' + durLive(st.seconds) : ''));
    else if (state === 'skipped') lines.push('- ↷ ' + r.title + ' — skipped');
    else if (state === 'active') lines.push('- ▶ ' + r.title + ' — running');
  });
  (S.db.extras[D.today()] || []).forEach(x => lines.push('- ＋ ' + D.hhmm(x.at) + ' ' + x.text + (x.minutes ? ' (' + dur(x.minutes) + ')' : '')));
  const w = weekProgress();
  lines.push('Week ' + w.done + '/' + w.n + ' rituals');
  (S.plan.goals || []).slice(0, 3).forEach(g => lines.push('- ' + g.project + ': ' + (g.detail || g.headline || '')));
  return lines.join('\n');
}

async function sendDayLog() {
  const btn = document.getElementById('send-day');
  const text = document.getElementById('log-day').value;
  if (!window.__WEBHOOK__) { copyText(text, 'Copied — paste it into #schedule'); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch(window.__WEBHOOK__, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), username: 'Ritual Log' }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Sent to #schedule');
  } catch (e) { toast('Could not send — use Copy'); }
  btn.disabled = false; btn.textContent = 'Send the whole day';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- wiring ---------- */
function tab(name) {
  S.tab = name;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.getElementById('view-today').hidden = name !== 'today';
  document.getElementById('view-week').hidden = name !== 'week';
  document.getElementById('view-ritual').hidden = name !== 'ritual';
  document.getElementById('view-summary').hidden = name !== 'summary';
  window.scrollTo({ top: 0 });
}
function openRitual(id) {
  S.ritualId = id;
  tab('ritual'); renderAll();
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, .row-ritual, .toggle, [data-xdel]');
  if (!t) return;
  if (t.dataset.openRitual) return openRitual(t.dataset.openRitual);
  if (t.dataset.tab) return tab(t.dataset.tab);
  const ritual = S.byId[S.ritualId];
  if (t.dataset.start) return ritual ? startStep(ritual, t.dataset.start) : null;
  if (t.dataset.pause) return ritual ? pauseStep(ritual, t.dataset.pause) : null;
  if (t.dataset.alt) return ritual ? completeStep(ritual, t.dataset.alt) : null;
  if (t.dataset.skip) {
    if (!ritual) return;
    const run = getRunFor(ritual); const st = run.steps[t.dataset.skip];
    if (st && (st.status === 'completed' || st.status === 'skipped')) reopenStep(ritual, t.dataset.skip);
    else completeStep(ritual, t.dataset.skip, true);
    return;
  }
  if (t.id === 'rv-abandon') return ritual ? abandonRun(ritual) : null;
  if (t.id === 'x-add') {
    const tx = document.getElementById('x-text').value.trim();
    const mn = Number(document.getElementById('x-min').value) || null;
    if (!tx) return toast('Write what you did first');
    addExtra(D.today(), tx, mn);
    document.getElementById('x-text').value = ''; document.getElementById('x-min').value = '';
    return;
  }
  if (t.dataset.xdel != null) return removeExtra(D.today(), Number(t.dataset.xdel));
  if (t.dataset.set) { S.db.settings[t.dataset.set] = !S.db.settings[t.dataset.set]; save(); renderAll(); return; }
  if (t.id === 'copy-day') return copyText(document.getElementById('log-day').value, 'Copied — ready to paste');
  if (t.id === 'send-day') return sendDayLog();
  if (t.id === 'tok-save') {
    const v = (document.getElementById('tok').value || '').trim();
    if (!v || /^•+$/.test(v)) return toast('Paste a token first');
    try { localStorage.setItem(LS_TOKEN, v); } catch (err) {}
    S.dirty = true; renderAll(); pull();
    return;
  }
  if (t.id === 'tok-clear') { localStorage.removeItem(LS_TOKEN); S.dirty = false; setSync('local', 'Not connected — this device only'); renderAll(); return; }
  if (t.id === 'sync-now') { S.dirty = true; return pull(); }
  if (t.id === 'backup') return copyText(JSON.stringify(S.db), 'Backup copied');
  if (t.id === 'restore') {
    const raw = prompt('Paste the backup JSON:');
    if (!raw) return;
    try { const p = JSON.parse(raw); if (!p.runs) throw new Error('no runs'); S.db = p; save(); markDirty(); renderAll(); toast('Restored'); }
    catch (err) { toast('That is not a valid backup'); }
    return;
  }
  if (t.id === 'wipe') { if (confirm('Erase every run stored on this device?')) { localStorage.removeItem(LS_DB); S.db = loadDB(); renderAll(); toast('Device data erased'); } return; }
  if (t.id === 'newver') { location.href = location.pathname + '?b=' + Date.now(); return; }
});

document.getElementById('x-text').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('x-add').click(); });
window.addEventListener('online', () => { flushOutbox(); if (token()) pull(); });

/* ---------- a running timer has to look like one ---------- */
/* Repaint only the live numbers once a second. Re-rendering the whole view on every
   tick would fight the drag gesture; leaving it to the 30 s pass is what made a
   started ritual sit on 0:00 and look broken. */
function paintLiveTimer() {
  const rid = activeAnywhere(); if (!rid) return;
  const ritual = S.byId[rid]; if (!ritual) return;
  const run = getRunFor(ritual, false); if (!run) return;
  const id = activeStepId(run); if (!id) return;
  const txt = timerText(stepElapsed(run, id));
  document.querySelectorAll('[data-open-ritual="' + rid + '"] .badge.live').forEach(b => { b.textContent = txt; });
  const li = document.querySelector('li.step[data-step="' + id + '"]');
  if (li) {
    const b = li.querySelector('.state .badge');
    if (b && b.classList.contains('live')) b.textContent = txt;
    const m = li.querySelector('.prog .micro');
    if (m) m.textContent = txt + (planMinutes(ritual) ? ' / ' + dur(planMinutes(ritual)) : '');
  }
}

/* ---------- stale tabs ---------- */
/* A tab loaded before a deploy keeps running yesterday's code — that is how a log
   line came through without its window. version.json is stamped per deploy, so the
   tab can notice and offer a reload instead of quietly misbehaving. */
let lastVerCheck = 0;
async function checkVersion(force) {
  const now = Date.now();
  if (!force && now - lastVerCheck < 60000) return;
  lastVerCheck = now;
  try {
    const r = await fetch('version.json?t=' + now, { cache: 'no-store' });
    if (!r.ok) return;
    const v = await r.json();
    const chip = document.getElementById('newver');
    if (v && v.build && BUILD !== '__BUILD__' && v.build !== BUILD) chip.hidden = false;
  } catch (e) { /* local dev has no version.json */ }
}

/* ---------- boot ---------- */
(function boot() {
  const cached = loadPlanCache();
  adoptPlan(cached || FALLBACK_PLAN);
  S.db = loadDB();
  S.ritualId = (todayRituals()[0] || (S.plan.rituals || [])[0] || {}).id || null;
  renderAll();
  tab('today');
  refreshPlan();
  flushOutbox();
  if (token()) pull(); else setSync('local', 'Not connected — this device only');
  S.tick = setInterval(() => {
    document.getElementById('clock').textContent = D.hhmm(Date.now());
    const r = S.byId[S.ritualId];
    if (r && activeStepId(getRunFor(r, false) || { steps: {} })) renderRitual();
    if (S.db.outbox.length) flushOutbox();
    if (S.dirty && !S.pushing && token()) push();
  }, 30000);
  S.timerTick = setInterval(paintLiveTimer, 1000);
  checkVersion(true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.dirty && token()) push(); return; }
    flushOutbox(); renderAll(); if (token()) pull(); checkVersion();
  });
})();
