'use strict';
/* Ritual Log — a Mini Rituals run for Rodri's day and week. Product copy is
   English-first, as the Mini Rituals repo is.

   Vocabulary is docs/CONTEXT.md's: ritual, revision, step, run, active run,
   completion, skip, slide to complete, completion moment, run summary, run
   history, sync state.

   Data model: the device keeps its own store (instant, offline) and the same
   document is shared across devices through one private gist — no server, no
   database. Every mutation stamps `ts` on the record it touches and merging
   takes the newer record per step and per run, so the phone and the laptop can
   both write without either losing work. Reading never blocks on the network:
   the local store renders immediately and the shared document is fetched on
   boot, on focus, and on demand. */

/* The shared document — a private gist. The id alone cannot read it; a GitHub
   token with `gist` scope can. */
const GIST_ID = 'f5e0ab302e947c02675069113296131f';
const GIST_FILE = 'ritual-log.json';
const LS_DB = 'ritual-log.v2';
const LS_PLAN = 'ritual-log.plan.v2';
const LS_TOKEN = 'ritual-log.token';

const FALLBACK_PLAN = {
  updated: null, week: { iso: '', label: '', start: null, end: null, reserve_saturday: false },
  rituals: {
    day: { title: 'Day', order_mode: 'sequential', steps: [
      { id: 'read', title: 'Read (+ coffee at the end)', start: '06:30', end: '07:20', minutes: 50 },
      { id: 'cleaning', title: 'Cleaning', start: '07:20', end: '08:30', minutes: 70 },
      { id: 'exercise-meditation', title: 'Exercise + meditation', start: '08:30', end: '09:30', minutes: 60 },
      { id: 'breakfast', title: 'Breakfast (cook + eat)', start: '09:30', end: '10:10', minutes: 40 },
      { id: 'shower-grooming', title: 'Shower + grooming', start: '10:10', end: '10:30', minutes: 20 },
      { id: 'work-a', title: 'Work A', start: '10:30', end: '13:30', minutes: 180, kind: 'work' },
      { id: 'cook-dinner', title: 'Cook + dinner (+ dishes)', start: '13:30', end: '15:30', minutes: 120 },
      { id: 'work-b', title: 'Work B', start: '15:30', end: '19:00', minutes: 210, kind: 'work' },
      { id: 'journaling', title: 'Journaling', start: '19:00', end: '19:30', minutes: 30 },
      { id: 'rest', title: 'Rest (games, Netflix, reading)', start: '19:30', end: '21:30', minutes: 120 },
      { id: 'lights-out', title: 'Lights out', start: '21:30', end: null, minutes: null }
    ] },
    week: { title: 'Week', order_mode: 'free', steps: [] }
  },
  days: {}, goals: [], anchors: []
};

const S = { plan: FALLBACK_PLAN, db: null, tab: 'today', ritual: 'day', tick: null,
  planError: null, sync: 'local', syncMsg: '', dirty: false, pushing: false };

/* ---------- store ---------- */
function loadDB() {
  try { const raw = localStorage.getItem(LS_DB); if (raw) return JSON.parse(raw); } catch (e) {}
  return { v: 2, runs: {}, settings: { slide: true, sound: true } };
}
function save() { S.db.updated = Date.now(); try { localStorage.setItem(LS_DB, JSON.stringify(S.db)); } catch (e) {} }
function loadPlanCache() {
  try { const raw = localStorage.getItem(LS_PLAN); if (raw) { const p = JSON.parse(raw); if (p && p.rituals) return p; } } catch (e) {}
  return null;
}
function token() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; } }

async function refreshPlan() {
  try {
    const res = await fetch('plan.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) { S.planError = 'HTTP ' + res.status; renderAll(); return; }
    const p = await res.json();
    if (!p || !p.rituals || !p.rituals.day) { S.planError = 'plan.json has no rituals'; renderAll(); return; }
    S.plan = p; S.planError = null;
    try { localStorage.setItem(LS_PLAN, JSON.stringify(p)); } catch (e) { S.planError = 'could not cache the plan'; }
    renderAll();
  } catch (e) { S.planError = (e && e.message) ? e.message : String(e); renderAll(); }
}

/* ---------- sync: one private gist is the whole backend ---------- */
function syncState(state, msg) { S.sync = state; S.syncMsg = msg || ''; renderSync(); }
function markDirty() { S.dirty = true; schedulePush(); }

let pushTimer = null;
function schedulePush(delay) {
  if (!token()) { syncState('local', 'Not connected — this device only'); return; }
  syncState('pending', 'Saving…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, delay == null ? 2500 : delay);
}

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, Object.assign({}, opts, {
    cache: 'no-store',
    headers: Object.assign({
      Authorization: 'token ' + token(),
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    }, opts.headers || {})
  }));
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}

async function pull() {
  if (!token()) { syncState('local', 'Not connected — this device only'); return; }
  syncState('syncing', 'Checking the shared log…');
  try {
    const g = await gh('/gists/' + GIST_ID);
    const file = g.files && g.files[GIST_FILE];
    const remote = file && file.content ? JSON.parse(file.content) : { v: 2, runs: {} };
    const merged = mergeDocs(S.db, remote);
    S.db.runs = merged.runs;
    save();
    renderAll();
    syncState('synced', 'Updated ' + D.hhmm(Date.now()));
    if (S.dirty) push();
  } catch (e) {
    syncState('failed', rejected(e) ? 'Token rejected — check it has gist access' : 'Could not reach the shared log (' + e.message + ')');
  }
}

async function push() {
  if (!token() || S.pushing) return;
  S.pushing = true;
  syncState('syncing', 'Saving…');
  try {
    const g = await gh('/gists/' + GIST_ID);
    const cur = g.files && g.files[GIST_FILE] && g.files[GIST_FILE].content ? JSON.parse(g.files[GIST_FILE].content) : { v: 2, runs: {} };
    const merged = mergeDocs(S.db, cur);
    S.db.runs = merged.runs;
    merged.updatedAt = Date.now();
    save();
    await gh('/gists/' + GIST_ID, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(merged) } } }) });
    S.dirty = false;
    renderAll();
    syncState('synced', 'Saved ' + D.hhmm(Date.now()));
  } catch (e) {
    syncState('failed', rejected(e) ? 'Token rejected — check it has gist access' : 'Not saved (' + e.message + ')');
  }
  S.pushing = false;
}
function rejected(e) { return e && (e.status === 401 || e.status === 403); }

/* Merge two documents. Per run and per step the newer `ts` wins, so a step
   completed on the phone is never undone by a stale screen on the laptop, and
   the union of both devices' work survives. */
function mergeDocs(a, b) {
  const out = { v: 2, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0), runs: {} };
  const keys = new Set(Object.keys(a.runs || {}).concat(Object.keys(b.runs || {})));
  keys.forEach(k => {
    const x = (a.runs || {})[k], y = (b.runs || {})[k];
    if (!x) { out.runs[k] = y; return; }
    if (!y) { out.runs[k] = x; return; }
    const run = ts(x) >= ts(y) ? Object.assign({}, x) : Object.assign({}, y);
    run.steps = {};
    const ids = new Set(Object.keys(x.steps || {}).concat(Object.keys(y.steps || {})));
    ids.forEach(id => {
      const sx = (x.steps || {})[id], sy = (y.steps || {})[id];
      if (!sx) run.steps[id] = sy;
      else if (!sy) run.steps[id] = sx;
      else run.steps[id] = ts(sx) >= ts(sy) ? sx : sy;
    });
    const extras = {};
    (x.extras || []).concat(y.extras || []).forEach(ex => { if (ex && ex.at != null) extras[ex.at + '|' + (ex.text || '')] = ex; });
    run.extras = Object.values(extras).sort((p, q) => p.at - q.at);
    run.startedAt = minDefined(x.startedAt, y.startedAt);
    run.endedAt = maxDefined(x.endedAt, y.endedAt);
    if (run.endedAt && run.status === 'active' && (x.status === 'completed' || y.status === 'completed')) run.status = 'completed';
    run.celebrated = !!(x.celebrated || y.celebrated);
    out.runs[k] = run;
  });
  return out;
}
function ts(r) { return (r && (r.ts || r.completedAt || r.endedAt || r.startedAt)) || 0; }
function minDefined(a, b) { const v = [a, b].filter(n => n != null); return v.length ? Math.min.apply(null, v) : null; }
function maxDefined(a, b) { const v = [a, b].filter(n => n != null); return v.length ? Math.max.apply(null, v) : null; }

/* ---------- dates ---------- */
const TZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const D = {
  key(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  hhmm(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
  short(d = new Date()) {
    const wd = d.toLocaleDateString('en-GB', { weekday: 'short' }).replace(/[.,]/g, '');
    const dm = d.toLocaleDateString('en-GB', { day: '2-digit' });
    const mo = d.toLocaleDateString('en-GB', { month: 'short' }).replace(/[.,]/g, '');
    return wd + ' ' + dm + ' ' + mo;
  },
  isoWeek(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear(); const start = new Date(Date.UTC(y, 0, 1));
    return y + '-W' + String(Math.ceil(((t - start) / 864e5 + 1) / 7)).padStart(2, '0');
  }
};
function dur(min) {
  min = Math.max(0, Math.round(min));
  return min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'm';
}
/* live elapsed under a minute reads in seconds — a run in progress should never
   look like it has done nothing */
function durLive(sec) { return sec < 60 ? Math.round(sec) + 's' : dur(sec / 60); }
function plannedMinutes(step) {
  if (step.minutes != null) return step.minutes;
  if (step.start && step.end) {
    const p = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    return Math.max(0, p(step.end) - p(step.start));
  }
  return null;
}

/* ---------- runs ---------- */
function runKey(ritual) { return ritual === 'day' ? 'day:' + D.key() : 'week:' + D.isoWeek(); }
function getRun(ritual, create = true) {
  const key = runKey(ritual);
  let run = S.db.runs[key];
  if (!run && create) {
    run = S.db.runs[key] = {
      key, ritual, scope: ritual === 'day' ? D.key() : D.isoWeek(),
      revision: S.plan.updated || null, startedAt: null, endedAt: null,
      status: 'active', steps: {}, extras: [], celebrated: false, ts: Date.now()
    };
    save();
  }
  return run;
}
/* A run is created when execution begins, not when a ritual is merely viewed:
   read paths render a throwaway view object instead. */
function viewRun(ritual) {
  return getRun(ritual, false) || {
    key: runKey(ritual), ritual, scope: ritual === 'day' ? D.key() : D.isoWeek(),
    revision: S.plan.updated || null, startedAt: null, endedAt: null,
    status: 'not started', steps: {}, extras: [], celebrated: false
  };
}
/* Spec: a ritual has at most one active run — a new run abandons an unfinished
   previous one (the day is disposable; history is not). */
function closeStaleRuns() {
  const today = runKey('day'), week = runKey('week');
  let changed = false;
  for (const k in S.db.runs) {
    const r = S.db.runs[k];
    if (r.status === 'active' && k !== today && k !== week) {
      r.status = 'abandoned'; r.endedAt = r.endedAt || Date.now(); r.ts = Date.now(); changed = true;
    }
  }
  if (changed) { save(); markDirty(); }
}
function stepElapsed(run, id) {
  const s = run.steps[id]; if (!s) return 0;
  let sec = s.seconds || 0;
  if (s.status === 'active' && s.startedAt) sec += (Date.now() - s.startedAt) / 1000;
  return sec;
}
function activeStepId(run) { for (const id in run.steps) if (run.steps[id].status === 'active') return id; return null; }
function ritualSteps(ritual) { return (S.plan.rituals[ritual] || {}).steps || []; }
function stepTitle(ritual, step) {
  if (ritual === 'day') {
    const day = (S.plan.days || {})[D.key()] || {};
    if (step.id === 'work-a' && day.work_a) return 'Work A · ' + day.work_a;
    if (step.id === 'work-b' && day.work_b) return 'Work B · ' + day.work_b;
  }
  return step.title;
}
function runCounts(run, ritual) {
  const steps = ritualSteps(ritual);
  let done = 0, skipped = 0;
  for (const st of steps) {
    const s = run.steps[st.id];
    if (s && (s.status === 'completed' || s.status === 'skipped')) { done++; if (s.skipped) skipped++; }
  }
  return { done, skipped, n: steps.length };
}

/* ---------- mutations ---------- */
function startStep(ritual, id) {
  const run = getRun(ritual);
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
  const run = getRun(ritual);
  const s = run.steps[id] || (run.steps[id] = { seconds: 0 });
  if (s.status === 'completed' || s.status === 'skipped') return;   // completions are idempotent
  const now = Date.now();
  if (s.status === 'active' && s.startedAt) s.seconds = (s.seconds || 0) + (now - s.startedAt) / 1000;
  s.status = skipped ? 'skipped' : 'completed';
  s.skipped = skipped; s.completedAt = now; s.startedAt = null; s.ts = now;
  if (!run.startedAt) run.startedAt = now;
  run.ts = now;
  haptic(skipped ? 'light' : 'medium');
  const c = runCounts(run, ritual);
  if (c.n && c.done === c.n && !skipped) {                                  // last step → completion moment
    run.status = 'completed'; run.endedAt = now; run.ts = now;
    if (!run.celebrated) { run.celebrated = true; save(); markDirty(); renderAll(); completionMoment(); return; }
  }
  save(); markDirty(); renderAll();
}
function reopenStep(ritual, id) {
  const run = getRun(ritual); const s = run.steps[id]; if (!s) return;
  s.status = 'pending'; s.skipped = false; s.completedAt = null; s.startedAt = null; s.ts = Date.now();
  if (run.status === 'completed') { run.status = 'active'; run.endedAt = null; run.ts = Date.now(); }
  save(); markDirty(); renderAll();
}
function pauseStep(ritual, id) {
  const run = getRun(ritual); const s = run.steps[id];
  if (s && s.status === 'active') {
    s.seconds = (s.seconds || 0) + (Date.now() - s.startedAt) / 1000; s.startedAt = null; s.status = 'pending'; s.ts = Date.now();
    save(); markDirty(); renderAll();
  }
}
function finishRun(ritual) {
  const run = getRun(ritual); const cur = activeStepId(run);
  if (cur) { const c = run.steps[cur]; c.seconds = (c.seconds || 0) + (Date.now() - c.startedAt) / 1000; c.startedAt = null; c.status = 'pending'; c.ts = Date.now(); }
  run.status = 'completed'; run.endedAt = Date.now(); run.ts = Date.now();
  save(); markDirty(); renderAll(); toast('Run closed');
}
function abandonRun(ritual) {
  const run = getRun(ritual);
  run.status = 'abandoned'; run.endedAt = Date.now(); run.ts = Date.now();
  save(); markDirty(); renderAll(); toast('Run abandoned — kept in history');
}
function addExtra(ritual, text, minutes) {
  const run = getRun(ritual);
  run.extras.push({ text, minutes: minutes || null, at: Date.now() });
  run.ts = Date.now();
  save(); markDirty(); renderAll();
}
function removeExtra(ritual, i) {
  const run = getRun(ritual); run.extras.splice(i, 1); run.ts = Date.now();
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
function completionMoment() {
  const el = document.getElementById('moment');
  el.classList.add('on'); bell(); haptic('medium');
  const colors = ['#C2410C', '#FB923C', '#15803D', '#4ADE80', '#A8A29E'];
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('i');
      p.className = 'confetti';
      p.style.background = colors[i % colors.length];
      p.style.left = (12 + Math.random() * 76) + 'vw'; p.style.top = '-12px';
      p.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
      document.body.appendChild(p);
      const dx = (Math.random() - .5) * 160, dy = window.innerHeight * (.55 + Math.random() * .45), rot = Math.random() * 720;
      p.animate([{ transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
                 { transform: `translate(${dx}px,${dy}px) rotate(${rot}deg)`, opacity: 0 }],
                { duration: 1500 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => p.remove();
    }
  }
  setTimeout(() => el.classList.remove('on'), 1500);
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
function renderAll() { renderHeader(); renderToday(); renderRitual(); renderSummary(); renderSync(); }

function renderHeader() {
  const now = new Date();
  document.getElementById('clock').textContent = D.hhmm(now.getTime());
  const wk = S.plan.week && S.plan.week.iso ? S.plan.week.iso : D.isoWeek();
  document.getElementById('dateline').textContent = D.short(now);
  document.getElementById('datesub').textContent = wk + (S.plan.week && S.plan.week.label ? ' · ' + S.plan.week.label : '') + ' · ' + TZ();
}

function ring(pct) {
  const r = 19, c = 2 * Math.PI * r;
  return '<div class="ring"><svg width="46" height="46" viewBox="0 0 46 46">' +
    '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--surface-2)" stroke-width="4"/>' +
    '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" ' +
    'stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '"/></svg>' +
    '<span class="pct tnum">' + Math.round(pct) + '%</span></div>';
}

function renderToday() {
  const banner = document.getElementById('today-banner');
  const anchorList = (S.plan.days && S.plan.days[D.key()] && S.plan.days[D.key()].anchors) || [];
  let html = anchorList.length ? '<div class="banner"><b>Today:</b> ' + anchorList.map(esc).join(' · ') + '</div>' : '';
  if (!S.plan.updated || S.planError) {
    html += '<div class="banner"><b>Plan not loaded</b>' + (S.planError ? ' (' + esc(S.planError) + ')' : '') +
      ': showing the skeleton saved on this device.</div>';
  }
  banner.innerHTML = html;

  document.getElementById('ritual-cards').innerHTML = ['day', 'week'].map(r => {
    const run = getRun(r, false);
    const c = run ? runCounts(run, r) : { done: 0, n: ritualSteps(r).length, skipped: 0 };
    const pct = c.n ? (c.done / c.n) * 100 : 0;
    const rtitle = (S.plan.rituals[r] || {}).title || r;
    const sub = run ? c.done + '/' + c.n + ' steps' + (c.skipped ? ' · ' + c.skipped + ' skipped' : '') +
      (run.endedAt && run.startedAt ? ' · ' + dur((run.endedAt - run.startedAt) / 60000) : '') +
      (run.status === 'active' ? '' : ' · ' + run.status) : 'not started';
    return '<button class="rcard" data-open="' + r + '">' + ring(pct) +
      '<span class="body"><span class="t">' + esc(rtitle) + '</span><span class="m">' + esc(sub) + '</span></span></button>';
  }).join('');

  document.getElementById('goals').innerHTML = (S.plan.goals || []).map(g =>
    '<div class="goal"><div class="gh"><span class="k">' + esc(g.project) + '</span>' +
      (g.status ? '<span class="badge ' + (g.status === 'at_risk' ? 'warn' : 'ok') + '">' + (g.status === 'at_risk' ? 'at risk' : 'on track') + '</span>' : '') +
      (g.headline ? '<span class="micro muted">' + esc(g.headline) + '</span>' : '') +
    '</div><div class="small">' + esc(g.detail || '') + '</div></div>').join('') ||
    '<div class="empty">The week goals arrive with the week plan.</div>';
}

function renderRitual() {
  const ritual = S.ritual, run = viewRun(ritual);
  const steps = ritualSteps(ritual);
  const c = runCounts(run, ritual);
  document.getElementById('rv-kicker').textContent = ritual === 'day' ? 'Ritual of the day' : 'Ritual of the week';
  document.getElementById('rv-title').textContent = (S.plan.rituals[ritual] || {}).title || ritual;
  document.getElementById('rv-pct').textContent = (c.n ? Math.round((c.done / c.n) * 100) : 0) + '%';
  document.getElementById('rv-state').textContent = run.status === 'active' ? 'active run' : run.status;
  document.getElementById('rv-state').className = 'badge ' + (run.status === 'active' ? 'a' : run.status === 'completed' ? 'ok' : 'n');
  document.getElementById('rv-sub').textContent = [
    ritual === 'day' ? D.key() : D.isoWeek(),
    (S.plan.rituals[ritual] || {}).order_mode === 'free' ? 'any order' : 'in order',
    c.done + '/' + c.n + ' completed', c.skipped + ' skipped',
    run.startedAt ? 'since ' + D.hhmm(run.startedAt) : 'not started'
  ].join(' · ');
  document.getElementById('rv-switch').innerHTML = ['day', 'week'].map(r =>
    '<button class="b sm' + (r === ritual ? ' primary' : '') + '" data-open="' + r + '">' + esc((S.plan.rituals[r] || {}).title || r) + '</button>').join('') +
    '<button class="b sm ghost" id="rv-moment">Moment</button>';

  if (!steps.length) {
    document.getElementById('steps').innerHTML = '';
    document.getElementById('steps-empty').hidden = false;
    document.getElementById('steps-empty').textContent = 'This ritual has no steps yet — the week plan brings them.';
  } else {
    document.getElementById('steps-empty').hidden = true;
    document.getElementById('steps').innerHTML = steps.map((st, i) => stepRow(ritual, run, st, i)).join('');
    wireSlides(ritual);
  }

  document.getElementById('extras').innerHTML = run.extras.length
    ? '<ul class="plain">' + run.extras.map((x, i) => '<li><span>' + esc(x.text) + '</span><span class="sp tnum">' +
        D.hhmm(x.at) + (x.minutes ? ' · ' + dur(x.minutes) : '') + '</span><button class="b sm ghost" data-xdel="' + i + '">×</button></li>').join('') + '</ul>'
    : '<div class="micro muted">Nothing extra logged today.</div>';
}

function stepRow(ritual, run, st, i) {
  const s = run.steps[st.id] || {};
  const status = s.status || 'pending';
  const plan = plannedMinutes(st);
  const el = stepElapsed(run, st.id);
  const elMin = el / 60;
  const over = plan && status === 'active' && elMin > plan;
  const win = st.start ? st.start + (st.end ? '–' + st.end : '') : (plan ? dur(plan) : '');
  const actual = s.completedAt || s.startedAt
    ? [s.startedAt ? D.hhmm(s.startedAt) : null, s.completedAt ? D.hhmm(s.completedAt) : 'now'].filter(Boolean).join('–')
    : null;
  const delta = plan && el > 20 ? Math.round(elMin - plan) : 0;

  let head = '';
  if (status === 'completed') head = '<span class="badge ok">' + (s.skipped ? 'skipped' : 'done') + '</span>';
  else if (status === 'skipped') head = '<span class="badge n">skipped</span>';
  else if (status === 'active') head = '<span class="badge ' + (over ? 'warn' : 'a') + ' tnum">' + durLive(el) + '</span>';
  else head = '<span class="badge n tnum">' + (plan ? dur(plan) : '—') + '</span>';

  const sub = [
    win ? 'plan ' + win : null,
    actual ? actual + (delta ? ' (' + (delta > 0 ? '+' : '') + delta + 'm)' : '') : null,
    st.optional ? 'optional' : null
  ].filter(Boolean).join(' · ');

  const prog = status === 'active'
    ? '<div class="prog"><span class="bar"><i style="width:' + Math.min(100, plan ? (elMin / plan) * 100 : 0) + '%"></i></span>' +
      '<span class="micro muted tnum">' + durLive(el) + (plan ? ' / ' + dur(plan) : '') + '</span></div>'
    : '';

  const acts = [];
  if (status === 'pending') acts.push('<button class="b sm" data-start="' + st.id + '">Start</button>');
  if (status === 'active') acts.push('<button class="b sm" data-pause="' + st.id + '">Pause</button>');
  acts.push('<button class="b sm ghost" data-skip="' + st.id + '">' + (status === 'skipped' || status === 'completed' ? 'Reopen' : 'Skip') + '</button>');

  const slide = (status === 'completed' || status === 'skipped') ? '' :
    '<div class="slide' + (S.db.settings.slide ? '' : ' tapmode') + '" data-slide="' + st.id + '">' +
      '<div class="fill"></div><div class="hint">' + (S.db.settings.slide ? 'Slide to complete' : 'Tap to complete') + '</div>' +
      (S.db.settings.slide ? '<div class="knob" role="slider" tabindex="0" aria-label="Slide to complete ' + esc(st.title) + '">→</div>' : '') +
    '</div>';

  const alt = (status === 'completed' || status === 'skipped') ? '' :
    '<button class="b sm" data-alt="' + st.id + '">Complete</button>';

  return '<li class="step ' + status + '" data-step="' + st.id + '">' +
    '<div class="sr"><span class="idx tnum">' + (i + 1) + '</span><span class="body">' +
    '<div class="t">' + esc(stepTitle(ritual, st)) + '</div>' +
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
      const up = () => {
        if (!dragging) return; dragging = false;
        if (dx / max() > .65) completeStep(ritual, id); else reset();
      };
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
  const ritual = S.ritual, run = viewRun(ritual);
  const c = runCounts(run, ritual);
  const total = run.startedAt ? ((run.endedAt || Date.now()) - run.startedAt) / 60000 : 0;
  const worked = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + stepElapsed(run, st.id) / 60, 0);
  const plannedWork = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + (plannedMinutes(st) || 0), 0);
  const rows = [
    ['Steps completed', c.done + '/' + c.n],
    ['Skipped', String(c.skipped)],
    ['Run duration', total ? dur(total) : '—'],
    ['Work', worked ? dur(worked) + (plannedWork ? ' / plan ' + dur(plannedWork) : '') : '—'],
    ['Extras', run.extras.length ? run.extras.length + ' · ' + dur(run.extras.reduce((a, x) => a + (x.minutes || 0), 0)) : '—'],
    ['Sync', S.sync === 'synced' ? 'shared log' : S.sync === 'local' ? 'this device only' : (S.syncMsg || S.sync)]
  ];
  document.getElementById('summary').innerHTML = rows.map(r => '<div class="kv"><span class="k">' + r[0] + '</span><span class="v tnum">' + esc(r[1]) + '</span></div>').join('') +
    '<div class="micro muted" style="margin-top:10px">Plan revision: ' + esc(run.revision || '—') + '</div>';
  document.getElementById('sum-state').textContent = run.status;

  const hist = Object.values(S.db.runs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 40);
  document.getElementById('history').innerHTML = hist.map(r => {
    const rc = runCounts(r, r.ritual);
    const t = r.startedAt ? ((r.endedAt || r.startedAt) - r.startedAt) / 60000 : 0;
    return '<li><span>' + r.scope + ' · ' + (r.ritual === 'day' ? 'Day' : 'Week') + '</span><span class="sp tnum">' + rc.done + '/' + rc.n +
      (t ? ' · ' + dur(t) : '') + ' · ' + r.status + '</span></li>';
  }).join('');
  document.getElementById('history-empty').hidden = hist.length > 0;

  document.getElementById('settings').innerHTML =
    '<div class="toggle ' + (S.db.settings.slide ? 'on' : '') + '" data-set="slide"><span class="lbl">Slide to complete<small>Off: the track completes on a tap instead.</small></span><span class="sw"></span></div>' +
    '<div class="toggle ' + (S.db.settings.sound ? 'on' : '') + '" data-set="sound"><span class="lbl">Chime when a run ends<small>One short bell on completion.</small></span><span class="sw"></span></div>';

  const ta = document.getElementById('log-day');
  if (ta && document.activeElement !== ta) ta.value = shareText();
  document.getElementById('send-day').hidden = !window.__WEBHOOK__;
  document.getElementById('send-note').textContent = window.__WEBHOOK__
    ? 'Sends the text above to #schedule exactly as it stands.'
    : 'No webhook configured: use Copy and paste it into #schedule.';
  document.getElementById('state-info').textContent =
    'Plan ' + (S.plan.updated || '—') + ' · saved ' + (S.db.updated ? new Date(S.db.updated).toLocaleString('en-GB') : '—') +
    ' · ' + Object.keys(S.db.runs).length + ' runs on this device';
}

const SYNC_LABEL = { local: 'this device', pending: 'saving', syncing: 'syncing', synced: 'synced', failed: 'not saved', conflict: 'conflict' };
const SYNC_CLASS = { local: 'n', pending: 'a', syncing: 'a', synced: 'ok', failed: 'warn', conflict: 'warn' };
function renderSync() {
  const chip = document.getElementById('sync-chip');
  const cls = SYNC_CLASS[S.sync] || 'n';
  chip.className = 'badge ' + cls;
  chip.textContent = SYNC_LABEL[S.sync] || S.sync;
  const el = document.getElementById('sync-card');
  if (!el) return;
  const tok = token();
  el.innerHTML =
    '<div class="card-head"><span class="k">Shared log</span><span class="spacer"></span><span class="badge ' + cls + '">' + esc(chip.textContent) + '</span></div>' +
    '<div class="small muted" style="margin-bottom:10px">' + esc(S.syncMsg || (tok ? 'Connected.' : 'Not connected — runs stay on this device.')) + '</div>' +
    '<div class="row"><input type="password" id="tok" autocomplete="off" placeholder="GitHub token with gist access" value="' + (tok ? '••••••••••••••••' : '') + '"></div>' +
    '<div class="row">' +
      '<button class="b sm primary" id="tok-save">' + (tok ? 'Replace token' : 'Connect') + '</button>' +
      '<button class="b sm" id="sync-now">Sync now</button>' +
      (tok ? '<button class="b sm ghost" id="tok-clear">Disconnect</button>' : '') +
    '</div>' +
    '<div class="micro muted" style="margin-top:10px">One private gist holds the log, and both devices read and write it — a step completed on the phone shows up on the laptop. ' +
    'The token stays in this browser, needs only <b>gist</b> access and can be revoked whenever. ' +
    '<a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Ritual%20Log" target="_blank" rel="noopener">Create one</a>.</div>';
}

/* ---------- share text (the run summary, in the channel's shape) ---------- */
function shareText() {
  const ritual = 'day', run = getRun(ritual, false);
  const lines = ['**Ritual Log · ' + D.short() + '**'];
  if (!run) { lines.push('No run yet today.'); }
  else {
    const c = runCounts(run, ritual);
    const total = run.startedAt ? ((run.endedAt || Date.now()) - run.startedAt) / 60000 : 0;
    const worked = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + stepElapsed(run, st.id) / 60, 0);
    lines.push('Day ' + c.done + '/' + c.n + (c.skipped ? ' · ' + c.skipped + ' skipped' : '') +
      (total ? ' · ' + dur(total) : '') + (worked ? ' · work ' + dur(worked) : ''));
    for (const st of ritualSteps(ritual)) {
      const s = run.steps[st.id]; if (!s) continue;
      const plan = plannedMinutes(st);
      const el = stepElapsed(run, st.id) / 60;
      const title = stepTitle(ritual, st);
      if (s.status === 'completed') {
        const d = plan && el > 20 ? ' (' + (el - plan > 0 ? '+' : '') + Math.round(el - plan) + 'm)' : (plan ? ' (plan ' + dur(plan) + ')' : '');
        lines.push('- ✅ ' + (s.startedAt ? D.hhmm(s.startedAt) + '–' : '') + (s.completedAt ? D.hhmm(s.completedAt) : '') + ' ' + title + ' — ' + dur(el) + d);
      } else if (s.status === 'skipped') lines.push('- ↷ ' + title + ' — skipped');
      else if (s.status === 'active') lines.push('- ▶ ' + title + ' — running ' + dur(el) + (plan ? ' / ' + dur(plan) : ''));
    }
    for (const x of run.extras) lines.push('- ＋ ' + D.hhmm(x.at) + ' ' + x.text + (x.minutes ? ' (' + dur(x.minutes) + ')' : ''));
    const wr = getRun('week', false);
    if (wr) { const wc = runCounts(wr, 'week'); lines.push('Week ' + wc.done + '/' + wc.n + ' done' + (wc.skipped ? ' · ' + wc.skipped + ' skipped' : '')); }
    for (const g of (S.plan.goals || []).slice(0, 3)) lines.push('- ' + g.project + ': ' + (g.detail || g.headline || ''));
  }
  return lines.join('\n');
}

async function sendToSchedule() {
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
  btn.disabled = false; btn.textContent = 'Send to #schedule';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- wiring ---------- */
function tab(name) {
  S.tab = name;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.getElementById('view-today').hidden = name !== 'today';
  document.getElementById('view-ritual').hidden = name !== 'ritual';
  document.getElementById('view-summary').hidden = name !== 'summary';
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, .rcard, .toggle, [data-xdel]');
  if (!t) return;
  if (t.dataset.tab) return tab(t.dataset.tab);
  if (t.dataset.open) { S.ritual = t.dataset.open; tab('ritual'); renderAll(); return; }
  if (t.dataset.start) return startStep(S.ritual, t.dataset.start);
  if (t.dataset.pause) return pauseStep(S.ritual, t.dataset.pause);
  if (t.dataset.alt) return completeStep(S.ritual, t.dataset.alt);
  if (t.dataset.skip) { const id = t.dataset.skip; const run = getRun(S.ritual); const st = run.steps[id];
    if (st && (st.status === 'completed' || st.status === 'skipped')) reopenStep(S.ritual, id); else completeStep(S.ritual, id, true); return; }
  if (t.id === 'rv-moment') return completionMoment();
  if (t.id === 'rv-finish') return finishRun(S.ritual);
  if (t.id === 'rv-abandon') return abandonRun(S.ritual);
  if (t.id === 'x-add') { const tx = document.getElementById('x-text').value.trim(); const mn = Number(document.getElementById('x-min').value) || null;
    if (!tx) return toast('Write what you did first'); addExtra(S.ritual, tx, mn); document.getElementById('x-text').value = ''; document.getElementById('x-min').value = ''; return; }
  if (t.dataset.xdel != null) return removeExtra(S.ritual, Number(t.dataset.xdel));
  if (t.dataset.set) { S.db.settings[t.dataset.set] = !S.db.settings[t.dataset.set]; save(); renderAll(); return; }
  if (t.id === 'copy-day') return copyText(document.getElementById('log-day').value, 'Copied — ready to paste');
  if (t.id === 'send-day') return sendToSchedule();
  if (t.id === 'tok-save') {
    const v = (document.getElementById('tok').value || '').trim();
    if (!v || /^•+$/.test(v)) return toast('Paste a token first');
    try { localStorage.setItem(LS_TOKEN, v); } catch (err) {}
    S.dirty = true; renderAll(); pull();
    return;
  }
  if (t.id === 'tok-clear') { localStorage.removeItem(LS_TOKEN); S.dirty = false; syncState('local', 'Not connected — this device only'); renderAll(); return; }
  if (t.id === 'sync-now') { S.dirty = S.dirty || true; return pull(); }
  if (t.id === 'backup') return copyText(JSON.stringify(S.db), 'Backup copied');
  if (t.id === 'restore') {
    const raw = prompt('Paste the backup JSON:');
    if (!raw) return;
    try { const p = JSON.parse(raw); if (!p.runs) throw new Error('no runs'); S.db = p; save(); markDirty(); renderAll(); toast('Restored'); }
    catch (err) { toast('That is not a valid backup'); }
    return;
  }
  if (t.id === 'wipe') { if (confirm('Erase every run stored on this device?')) { localStorage.removeItem(LS_DB); S.db = loadDB(); renderAll(); toast('Device data erased'); } return; }
});

document.getElementById('x-text').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('x-add').click(); });

/* ---------- boot ---------- */
(function boot() {
  S.plan = loadPlanCache() || FALLBACK_PLAN;
  S.db = loadDB();
  closeStaleRuns();
  renderAll();
  tab('today');
  refreshPlan();
  if (token()) pull(); else syncState('local', 'Not connected — this device only');
  S.tick = setInterval(() => {
    document.getElementById('clock').textContent = D.hhmm(Date.now());
    const run = getRun(S.ritual, false);
    if (run && activeStepId(run)) renderRitual();
    if (S.dirty && !S.pushing && token()) push();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.dirty && token()) push(); return; }
    closeStaleRuns(); renderAll(); pull();
  });
})();
