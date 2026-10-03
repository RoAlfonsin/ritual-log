'use strict';
/* Ritual Log — a Mini Rituals run, for Rodri's day and week.
   Vocabulary is docs/CONTEXT.md's: ritual, revision, step, run, active run,
   completion, skip, slide to complete, completion moment, run summary, run history.
   Local-first: the device's own store is the source of truth; the network never
   blocks a read (the plan is served from cache and refreshed in the background). */

const LS_DB = 'ritual-log.v1';
const LS_PLAN = 'ritual-log.plan.v1';

const FALLBACK_PLAN = {
  updated: null, week: { iso: '', label: '', start: null, end: null, reserve_saturday: false },
  rituals: {
    day: { title: 'Día', order_mode: 'sequential', steps: [
      { id: 'read', title: 'Leer (+ café al final)', start: '06:30', end: '07:20', minutes: 50 },
      { id: 'cleaning', title: 'Limpieza', start: '07:20', end: '08:30', minutes: 70 },
      { id: 'exercise-meditation', title: 'Ejercicio + meditación', start: '08:30', end: '09:30', minutes: 60 },
      { id: 'breakfast', title: 'Desayuno', start: '09:30', end: '10:10', minutes: 40 },
      { id: 'shower-grooming', title: 'Ducha + aseo', start: '10:10', end: '10:30', minutes: 20 },
      { id: 'work-a', title: 'Trabajo A', start: '10:30', end: '13:30', minutes: 180, kind: 'work' },
      { id: 'cook-dinner', title: 'Cocinar + cena', start: '13:30', end: '15:30', minutes: 120 },
      { id: 'work-b', title: 'Trabajo B', start: '15:30', end: '19:00', minutes: 210, kind: 'work' },
      { id: 'journaling', title: 'Journaling', start: '19:00', end: '19:30', minutes: 30 },
      { id: 'rest', title: 'Descanso', start: '19:30', end: '21:30', minutes: 120 },
      { id: 'lights-out', title: 'Apagar luces', start: '21:30', end: null, minutes: null }
    ] },
    week: { title: 'Semana', order_mode: 'free', steps: [] }
  },
  days: {}, goals: [], anchors: []
};

const S = { plan: FALLBACK_PLAN, db: null, tab: 'hoy', ritual: 'day', tick: null };

/* ---------- store ---------- */
function loadDB() {
  try { const raw = localStorage.getItem(LS_DB); if (raw) return JSON.parse(raw); } catch (e) {}
  return { v: 1, runs: {}, settings: { slide: true, sound: true } };
}
function save() { S.db.updated = Date.now(); try { localStorage.setItem(LS_DB, JSON.stringify(S.db)); } catch (e) {} }
function loadPlanCache() {
  try { const raw = localStorage.getItem(LS_PLAN); if (raw) { const p = JSON.parse(raw); if (p && p.rituals) return p; } } catch (e) {}
  return null;
}
async function refreshPlan() {
  try {
    const res = await fetch('plan.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) { S.planError = 'HTTP ' + res.status; renderAll(); return; }
    const p = await res.json();
    if (!p || !p.rituals || !p.rituals.day) { S.planError = 'plan.json sin rituales'; renderAll(); return; }
    S.plan = p; S.planError = null;
    try { localStorage.setItem(LS_PLAN, JSON.stringify(p)); } catch (e) { S.planError = 'no se pudo cachear el plan'; }
    renderAll();
  } catch (e) { S.planError = (e && e.message) ? e.message : String(e); renderAll(); }
}

/* ---------- dates ---------- */
const TZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const D = {
  key(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  hhmm(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
  long(d = new Date()) {
    const wd = d.toLocaleDateString('es-MX', { weekday: 'short' }).replace(/[.,]/g, '');
    const dm = d.toLocaleDateString('es-MX', { day: '2-digit' });
    const mo = d.toLocaleDateString('es-MX', { month: 'short' }).replace(/[.,]/g, '');
    return wd + ' ' + dm + ' ' + mo;
  },
  isoWeek(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear(); const start = new Date(Date.UTC(y, 0, 1));
    return y + '-W' + String(Math.ceil(((t - start) / 864e5 + 1) / 7)).padStart(2, '0');
  },
  addDays(ms, n) { return ms + n * 864e5; }
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
      status: 'active', steps: {}, extras: [], celebrated: false
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
    status: 'pendiente', steps: {}, extras: [], celebrated: false
  };
}
/* Spec: a ritual has at most one active run — a new run abandons an unfinished
   previous one (the day is disposable; history is not). */
function closeStaleRuns() {
  const today = runKey('day'), week = runKey('week');
  let changed = false;
  for (const k in S.db.runs) {
    const r = S.db.runs[k];
    if (r.status === 'active' && k !== today && k !== week) { r.status = 'abandoned'; r.endedAt = r.endedAt || Date.now(); changed = true; }
  }
  if (changed) save();
}
function stepState(run, id) { const s = run.steps[id]; return s ? s.status : 'pending'; }
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
    if (step.id === 'work-a' && day.work_a) return 'Trabajo A · ' + day.work_a;
    if (step.id === 'work-b' && day.work_b) return 'Trabajo B · ' + day.work_b;
  }
  return step.title;
}
function runCounts(run, ritual) {
  const steps = ritualSteps(ritual);
  let done = 0, skipped = 0, total = 0;
  for (const st of steps) {
    total += st.kind === 'work' ? (plannedMinutes(st) || 0) : 0;
    const s = run.steps[st.id];
    if (s && (s.status === 'completed' || s.status === 'skipped')) { done++; if (s.skipped) skipped++; }
  }
  return { done, skipped, total, n: steps.length };
}

/* ---------- mutations ---------- */
function startStep(ritual, id) {
  const run = getRun(ritual);
  const cur = activeStepId(run);
  if (cur === id) return;
  if (cur) { const c = run.steps[cur]; c.seconds = (c.seconds || 0) + (Date.now() - c.startedAt) / 1000; c.status = 'pending'; c.startedAt = null; }
  const s = run.steps[id] || (run.steps[id] = { seconds: 0 });
  s.status = 'active'; s.startedAt = Date.now(); s.completedAt = null; s.skipped = false;
  if (!run.startedAt) run.startedAt = Date.now();
  run.status = 'active';
  save(); haptic('light'); renderAll();
}
function completeStep(ritual, id, skipped = false) {
  const run = getRun(ritual);
  const s = run.steps[id] || (run.steps[id] = { seconds: 0 });
  if (s.status === 'completed' || s.status === 'skipped') return;   // completions are idempotent
  if (s.status === 'active' && s.startedAt) s.seconds = (s.seconds || 0) + (Date.now() - s.startedAt) / 1000;
  s.status = skipped ? 'skipped' : 'completed';
  s.skipped = skipped; s.completedAt = Date.now(); s.startedAt = null;
  if (!run.startedAt) run.startedAt = s.completedAt;
  haptic(skipped ? 'light' : 'medium');
  const c = runCounts(run, ritual);
  if (c.n && c.done === c.n && !skipped) {                                   // last step → completion moment
    run.status = 'completed'; run.endedAt = s.completedAt;
    if (!run.celebrated) { run.celebrated = true; save(); renderAll(); completionMoment(); return; }
  }
  save(); renderAll();
}
function reopenStep(ritual, id) {
  const run = getRun(ritual); const s = run.steps[id]; if (!s) return;
  s.status = 'pending'; s.skipped = false; s.completedAt = null; s.startedAt = null;
  if (run.status === 'completed') { run.status = 'active'; run.endedAt = null; }
  save(); renderAll();
}
function finishRun(ritual) {
  const run = getRun(ritual); const cur = activeStepId(run);
  if (cur) { const c = run.steps[cur]; c.seconds = (c.seconds || 0) + (Date.now() - c.startedAt) / 1000; c.startedAt = null; c.status = 'pending'; }
  run.status = 'completed'; run.endedAt = Date.now(); save(); renderAll(); toast('Run terminado'); 
}
function abandonRun(ritual) {
  const run = getRun(ritual);
  run.status = 'abandoned'; run.endedAt = Date.now(); save(); renderAll(); toast('Run abandonado — queda en el historial');
}
function addExtra(ritual, text, minutes) {
  const run = getRun(ritual);
  run.extras.push({ text, minutes: minutes || null, at: Date.now() });
  save(); renderAll();
}
function removeExtra(ritual, i) { const run = getRun(ritual); run.extras.splice(i, 1); save(); renderAll(); }
function moveDay() { /* reserved: steps carry their own reset via a new day's run */ }

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
      const dx = (Math.random() - .5) * 160, dy = window.innerHeight * (0.55 + Math.random() * .45), rot = Math.random() * 720;
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
  const done = () => toast(okMsg || 'Copiado');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar'); }
  ta.remove();
}

/* ---------- render ---------- */
function renderAll() { renderHeader(); renderHoy(); renderRitual(); renderResumen(); }

function renderHeader() {
  const now = new Date();
  document.getElementById('clock').textContent = D.hhmm(now.getTime());
  const wk = S.plan.week && S.plan.week.iso ? S.plan.week.iso : D.isoWeek();
  document.getElementById('dateline').textContent = D.long(now);
  document.getElementById('datesub').textContent = wk + (S.plan.week && S.plan.week.label ? ' · ' + S.plan.week.label : '') +
    ' · ' + TZ();
}

function ring(pct) {
  const r = 19, c = 2 * Math.PI * r;
  return '<div class="ring"><svg width="46" height="46" viewBox="0 0 46 46">' +
    '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--surface-2)" stroke-width="4"/>' +
    '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" ' +
    'stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '"/></svg>' +
    '<span class="pct tnum">' + Math.round(pct) + '%</span></div>';
}

function renderHoy() {
  const banner = document.getElementById('hoy-banner');
  const anchorList = (S.plan.days && S.plan.days[D.key()] && S.plan.days[D.key()].anchors) || [];
  let html = anchorList.length ? '<div class="banner"><b>Hoy:</b> ' + anchorList.map(esc).join(' · ') + '</div>' : '';
  if (!S.plan.updated || S.planError) {
    html += '<div class="banner"><b>Plan sin cargar</b>' + (S.planError ? ' (' + esc(S.planError) + ')' : '') +
      ': se usa el esqueleto guardado en este dispositivo.</div>';
  }
  banner.innerHTML = html;

  const out = ['day', 'week'].map(r => {
    const run = getRun(r, false);
    const c = run ? runCounts(run, r) : { done: 0, n: ritualSteps(r).length, skipped: 0 };
    const pct = c.n ? (c.done / c.n) * 100 : 0;
    const rtitle = (S.plan.rituals[r] || {}).title || r;
    const sub = run ? c.done + '/' + c.n + ' pasos' + (c.skipped ? ' · ' + c.skipped + ' skip' : '') +
      (run.endedAt && run.startedAt ? ' · ' + dur((run.endedAt - run.startedAt) / 60000) : '') +
      (run.status === 'active' ? '' : ' · ' + run.status) : 'sin empezar';
    return '<button class="rcard" data-open="' + r + '">' + ring(pct) +
      '<span class="body"><span class="t">' + esc(rtitle) + '</span><span class="m">' + esc(sub) + '</span></span></button>';
  }).join('');
  document.getElementById('ritual-cards').innerHTML = out;

  const goals = (S.plan.goals || []).map(g =>
    '<div class="goal"><div class="gh"><span class="k">' + esc(g.project) + '</span>' +
      (g.status ? '<span class="badge ' + (g.status === 'at_risk' ? 'warn' : 'ok') + '">' + (g.status === 'at_risk' ? 'riesgo' : 'en curso') + '</span>' : '') +
      (g.headline ? '<span class="micro muted">' + esc(g.headline) + '</span>' : '') +
    '</div><div class="small">' + esc(g.detail || '') + '</div></div>').join('') ||
    '<div class="empty">Los objetivos llegan con el plan de la semana.</div>';
  document.getElementById('goals').innerHTML = goals;
}

function renderRitual() {
  const ritual = S.ritual, run = viewRun(ritual);
  const rtitle = (S.plan.rituals[ritual] || {}).title || ritual;
  const steps = ritualSteps(ritual);
  const c = runCounts(run, ritual);
  document.getElementById('rv-kicker').textContent = ritual === 'day' ? 'Ritual del día' : 'Ritual de la semana';
  document.getElementById('rv-title').textContent = rtitle;
  document.getElementById('rv-pct').textContent = (c.n ? Math.round((c.done / c.n) * 100) : 0) + '%';
  document.getElementById('rv-state').textContent = run.status === 'active' ? 'run activo' : run.status;
  document.getElementById('rv-state').className = 'badge ' + (run.status === 'active' ? 'a' : run.status === 'completed' ? 'ok' : 'n');
  const sub = [ritual === 'day' ? D.key() : D.isoWeek(),
    (S.plan.rituals[ritual] || {}).order_mode === 'free' ? 'orden libre' : 'secuencial',
    c.done + '/' + c.n + ' completados', c.skipped + ' skip', run.startedAt ? 'desde ' + D.hhmm(run.startedAt) : 'sin empezar',
    'local'].join(' · ');
  document.getElementById('rv-sub').textContent = sub;
  document.getElementById('rv-switch').innerHTML = ['day', 'week'].map(r =>
    '<button class="b sm' + (r === ritual ? ' primary' : '') + '" data-open="' + r + '">' + esc((S.plan.rituals[r] || {}).title || r) + '</button>').join('') +
    '<button class="b sm ghost" id="rv-moment">Momento</button>';

  if (!steps.length) {
    document.getElementById('steps').innerHTML = '';
    document.getElementById('steps-empty').hidden = false;
    document.getElementById('steps-empty').textContent = 'Este ritual aún no tiene pasos. El plan de la semana los trae.';
  } else {
    document.getElementById('steps-empty').hidden = true;
    document.getElementById('steps').innerHTML = steps.map((st, i) => stepRow(ritual, run, st, i)).join('');
    wireSlides(ritual);
  }

  document.getElementById('extras').innerHTML = run.extras.length
    ? '<ul class="plain">' + run.extras.map((x, i) => '<li><span>' + esc(x.text) + '</span><span class="sp tnum">' +
        D.hhmm(x.at) + (x.minutes ? ' · ' + dur(x.minutes) : '') + '</span><button class="b sm ghost" data-xdel="' + i + '">×</button></li>').join('') + '</ul>'
    : '<div class="micro muted">Nada extra registrado hoy.</div>';
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
    ? [s.startedAt ? D.hhmm(s.startedAt) : null, s.completedAt ? D.hhmm(s.completedAt) : 'ahora'].filter(Boolean).join('–')
    : null;
  const delta = plan && el > 20 ? Math.round(elMin - plan) : 0;

  let head = '';
  if (status === 'completed') head = '<span class="badge ok">' + (s.skipped ? 'skip' : 'hecho') + '</span>';
  else if (status === 'skipped') head = '<span class="badge n">skip</span>';
  else if (status === 'active') head = '<span class="badge ' + (over ? 'warn' : 'a') + ' tnum">' + durLive(el) + '</span>';
  else head = '<span class="badge n tnum">' + (plan ? dur(plan) : '—') + '</span>';

  const sub = [
    win ? 'plan ' + win : null,
    actual ? actual + (delta ? ' (' + (delta > 0 ? '+' : '') + delta + 'm)' : '') : null,
    st.optional ? 'opcional' : null
  ].filter(Boolean).join(' · ');

  const prog = status === 'active'
    ? '<div class="prog"><span class="bar"><i style="width:' + Math.min(100, plan ? (elMin / plan) * 100 : 0) + '%"></i></span>' +
      '<span class="micro muted tnum">' + durLive(el) + (plan ? ' / ' + dur(plan) : '') + '</span></div>'
    : '';

  const acts = [];
  if (status === 'pending') acts.push('<button class="b sm" data-start="' + st.id + '">Iniciar</button>');
  if (status === 'active') acts.push('<button class="b sm" data-pause="' + st.id + '">Pausar</button>');
  acts.push('<button class="b sm ghost" data-skip="' + st.id + '">' + (status === 'skipped' || status === 'completed' ? 'Reabrir' : 'Skip') + '</button>');

  const slide = (status === 'completed' || status === 'skipped') ? '' :
    '<div class="slide' + (S.db.settings.slide ? '' : ' tapmode') + '" data-slide="' + st.id + '">' +
      '<div class="fill"></div><div class="hint">' + (S.db.settings.slide ? 'Desliza para completar' : 'Toca para completar') + '</div>' +
      (S.db.settings.slide ? '<div class="knob" role="slider" tabindex="0" aria-label="Desliza para completar ' + esc(st.title) + '">→</div>' : '') +
    '</div>';

  const alt = (status === 'completed' || status === 'skipped') ? '' :
    '<button class="b sm" data-alt="' + st.id + '">Completar (alternativa accesible)</button>';

  return '<li class="step ' + status + '" data-step="' + st.id + '">' +
    '<div class="sr"><span class="idx tnum">' + (i + 1) + '</span><span class="body">' +
    '<div class="t">' + esc(stepTitle(ritual, st)) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + prog +
    '</span><span class="state">' + head + '</span></div>' +
    slide + '<div class="step-acts">' + acts.join('') + alt + '</div></li>';
}

/* slide to complete — full-width drag, committing past the threshold;
   the tap setting (US-004) and the alternative button replace the gesture. */
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
        if (dx / max() > .65) { completeStep(ritual, id); } else { reset(); }
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

function renderResumen() {
  const ritual = S.ritual, run = viewRun(ritual);
  const sums = document.getElementById('summary');
  const c = runCounts(run, ritual);
  const total = run.startedAt ? ((run.endedAt || Date.now()) - run.startedAt) / 60000 : 0;
  const worked = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + stepElapsed(run, st.id) / 60, 0);
  const plannedWork = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + (plannedMinutes(st) || 0), 0);
  const rows = [
    ['Pasos completados', c.done + '/' + c.n],
    ['Skips', String(c.skipped)],
    ['Duración del run', total ? dur(total) : '—'],
    ['Trabajo', worked ? dur(worked) + (plannedWork ? ' / plan ' + dur(plannedWork) : '') : '—'],
    ['Extras', run.extras.length ? run.extras.length + ' · ' + dur(run.extras.reduce((a, x) => a + (x.minutes || 0), 0)) : '—'],
    ['Sync', 'local (este dispositivo)']
  ];
  sums.innerHTML = rows.map(r => '<div class="kv"><span class="k">' + r[0] + '</span><span class="v tnum">' + esc(r[1]) + '</span></div>').join('') +
    '<div class="micro muted" style="margin-top:10px">Revisión del plan: ' + esc(run.revision || '—') + '</div>';
  document.getElementById('sum-state').textContent = run.status;

  const hist = Object.values(S.db.runs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 40);
  document.getElementById('history').innerHTML = hist.map(r => {
    const c = runCounts(r, r.ritual);
    const t = r.startedAt ? ((r.endedAt || r.startedAt) - r.startedAt) / 60000 : 0;
    const label = r.ritual === 'day' ? 'Día' : 'Semana';
    return '<li><span>' + r.scope + ' · ' + label + '</span><span class="sp tnum">' + c.done + '/' + c.n +
      (t ? ' · ' + dur(t) : '') + ' · ' + r.status + '</span></li>';
  }).join('');
  document.getElementById('history-empty').hidden = hist.length > 0;

  document.getElementById('settings').innerHTML =
    '<div class="toggle ' + (S.db.settings.slide ? 'on' : '') + '" data-set="slide"><span class="lbl">Deslizar para completar</span><span class="sw"></span></div>' +
    '<div class="toggle ' + (S.db.settings.sound ? 'on' : '') + '" data-set="sound"><span class="lbl">Campana al terminar</span><span class="sw"></span></div>';

  const ta = document.getElementById('log-day');
  if (ta && document.activeElement !== ta) ta.value = shareText();
  document.getElementById('send-note').textContent = window.__WEBHOOK__
    ? 'El envío va directo a #schedule con el texto de arriba, tal como está.'
    : 'Sin webhook configurado: usa «Copiar» y pega en #schedule.';
  const sendBtn = document.getElementById('send-day');
  sendBtn.hidden = !window.__WEBHOOK__;
  document.getElementById('state-info').textContent =
    'Plan: ' + (S.plan.updated || '—') + ' · guardado: ' + (S.db.updated ? new Date(S.db.updated).toLocaleString('es-MX') : '—') +
    ' · ' + Object.keys(S.db.runs).length + ' runs';
}

/* ---------- share text (the run summary, in the channel's shape) ---------- */
function shareText() {
  const ritual = 'day', run = getRun(ritual, false);
  const lines = ['**Ritual Log · ' + D.long() + '**'];
  if (!run) { lines.push('Sin run todavía.'); }
  else {
    const c = runCounts(run, ritual);
    const total = run.startedAt ? ((run.endedAt || Date.now()) - run.startedAt) / 60000 : 0;
    const worked = ritualSteps(ritual).filter(st => st.kind === 'work').reduce((a, st) => a + stepElapsed(run, st.id) / 60, 0);
    lines.push('Día ' + c.done + '/' + c.n + (c.skipped ? ' · ' + c.skipped + ' skip' : '') +
      (total ? ' · ' + dur(total) : '') + (worked ? ' · trabajo ' + dur(worked) : ''));
    for (const st of ritualSteps(ritual)) {
      const s = run.steps[st.id]; if (!s) continue;
      const plan = plannedMinutes(st);
      const el = stepElapsed(run, st.id) / 60;
      const title = stepTitle(ritual, st);
      if (s.status === 'completed') {
        const d = plan && el > 20 ? ' (' + (el - plan > 0 ? '+' : '') + Math.round(el - plan) + 'm)' : (plan ? ' (plan ' + dur(plan) + ')' : '');
        lines.push('- ✅ ' + (s.startedAt ? D.hhmm(s.startedAt) + '–' : '') + (s.completedAt ? D.hhmm(s.completedAt) : '') + ' ' + title + ' — ' + dur(el) + d);
      } else if (s.status === 'skipped') lines.push('- ↷ ' + title + ' — skip');
      else if (s.status === 'active') lines.push('- ▶ ' + title + ' — en curso ' + dur(el) + (plan ? ' / ' + dur(plan) : ''));
    }
    for (const x of run.extras) lines.push('- ＋ ' + D.hhmm(x.at) + ' ' + x.text + (x.minutes ? ' (' + dur(x.minutes) + ')' : ''));
    const wr = getRun('week', false);
    if (wr) { const wc = runCounts(wr, 'week'); lines.push('Semana ' + wc.done + '/' + wc.n + ' hechos' + (wc.skipped ? ' · ' + wc.skipped + ' skip' : '')); }
    for (const g of (S.plan.goals || []).slice(0, 3)) lines.push('- ' + g.project + ': ' + (g.detail || g.headline || ''));
  }
  return lines.join('\n');
}

async function sendToSchedule() {
  const btn = document.getElementById('send-day');
  const text = document.getElementById('log-day').value;
  if (!window.__WEBHOOK__) { copyText(text, 'Copiado — pégalo en #schedule'); return; }
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const r = await fetch(window.__WEBHOOK__, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), username: 'Ritual Log' }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Enviado a #schedule');
  } catch (e) { toast('No se pudo enviar: usa Copiar'); }
  btn.disabled = false; btn.textContent = 'Enviar a #schedule';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- wiring ---------- */
function tab(name) {
  S.tab = name;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.getElementById('view-hoy').hidden = name !== 'hoy';
  document.getElementById('view-ritual').hidden = name !== 'ritual';
  document.getElementById('view-resumen').hidden = name !== 'resumen';
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, .rcard, .toggle, [data-xdel]');
  if (!t) return;
  if (t.dataset.tab) return tab(t.dataset.tab);
  if (t.dataset.open) { S.ritual = t.dataset.open; tab('ritual'); renderAll(); return; }
  if (t.dataset.start) return startStep(S.ritual, t.dataset.start);
  if (t.dataset.pause) { const id = t.dataset.pause; const run = getRun(S.ritual); const s = run.steps[id];
    if (s && s.status === 'active') { s.seconds = (s.seconds || 0) + (Date.now() - s.startedAt) / 1000; s.startedAt = null; s.status = 'pending'; save(); renderAll(); } return; }
  if (t.dataset.alt) return completeStep(S.ritual, t.dataset.alt);
  if (t.dataset.skip) { const id = t.dataset.skip; const run = getRun(S.ritual); const st = run.steps[id];
    if (st && (st.status === 'completed' || st.status === 'skipped')) reopenStep(S.ritual, id); else completeStep(S.ritual, id, true); return; }
  if (t.id === 'rv-moment') return completionMoment();
  if (t.id === 'rv-finish') return finishRun(S.ritual);
  if (t.id === 'rv-abandon') return abandonRun(S.ritual);
  if (t.id === 'x-add') { const tx = document.getElementById('x-text').value.trim(); const mn = Number(document.getElementById('x-min').value) || null;
    if (!tx) return toast('Escribe qué hiciste'); addExtra(S.ritual, tx, mn); document.getElementById('x-text').value = ''; document.getElementById('x-min').value = ''; return; }
  if (t.dataset.xdel != null) return removeExtra(S.ritual, Number(t.dataset.xdel));
  if (t.dataset.set) { S.db.settings[t.dataset.set] = !S.db.settings[t.dataset.set]; save(); renderAll(); return; }
  if (t.id === 'copy-day') return copyText(document.getElementById('log-day').value, 'Copiado — listo para pegar');
  if (t.id === 'send-day') return sendToSchedule();
  if (t.id === 'backup') return copyText(JSON.stringify(S.db), 'Respaldo copiado');
  if (t.id === 'restore') {
    const raw = prompt('Pega el respaldo JSON:');
    if (!raw) return;
    try { const p = JSON.parse(raw); if (!p.runs) throw new Error('sin runs'); S.db = p; save(); renderAll(); toast('Restaurado'); }
    catch (err) { toast('Respaldo inválido'); }
    return;
  }
  if (t.id === 'wipe') { if (confirm('¿Borrar todos los runs de este dispositivo?')) { localStorage.removeItem(LS_DB); S.db = loadDB(); renderAll(); toast('Datos borrados'); } return; }
});

document.getElementById('x-text').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('x-add').click(); });

/* ---------- boot ---------- */
(function boot() {
  S.plan = loadPlanCache() || FALLBACK_PLAN;
  S.db = loadDB();
  closeStaleRuns();
  renderAll();
  tab('hoy');
  refreshPlan();
  S.tick = setInterval(() => {
    const now = new Date();
    document.getElementById('clock').textContent = D.hhmm(now.getTime());
    const run = getRun(S.ritual, false);
    if (run && activeStepId(run)) renderRitual();
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { closeStaleRuns(); renderAll(); } });
})();
