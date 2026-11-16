// Erg TV: the big screen in front of the erg. The hero is a live split
// breakdown of the current piece (what the PM5 itself doesn't show), with
// the live split / rate / HR / distance in a strip on the right.
//
// Runs two ways:
//   - inside the Android TV app (android/): PM5Native, auto-connects
//   - in desktop Chrome: Web Bluetooth (PM5) or the demo workout (PM5Mock)
// The maths is in tv-logic.js and splits.js (both tested); this is DOM glue.

const $ = sel => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const NATIVE = typeof PM5Native !== 'undefined' && PM5Native.available();
const PLAN_URL = 'https://noluckmurphy.github.io/pm5-base/tv/today.json';
const STORAGE_KEY = 'erg-tv-v2';
const PRESET_ORDER = ['threshold', 'max', 'test', 'zone2', 'free'];

// ---------- persisted per-browser state (safe if storage is blocked) ----------
const store = {
    load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } },
    save(v) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
};
const saved = store.load();

const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- targets: plan for today, remote override on top ----------
let planDay = null;                      // from today.json
let planSource = 'none';                 // 'live' | 'bundled' | 'none'
let manual = saved.manual?.date === todayKey() ? saved.manual : null;   // { date, preset, shift }
const hrBounds = saved.hrBounds ?? [...tvLogic.DEFAULT_HR_BOUNDS];

const target = () => {
    const base = manual?.preset
        ? { ...tvLogic.PRESETS[manual.preset], preset: manual.preset }
        : planDay
        ? { ...tvLogic.PRESETS[planDay.preset], ...planDay }
        : { ...tvLogic.PRESETS[saved.lastPreset ?? 'threshold'], preset: saved.lastPreset ?? 'threshold' };
    const shift = manual?.shift ?? 0;
    return { ...base, fast: base.fast + shift, slow: base.slow + shift, shift, fromPlan: !manual?.preset && !!planDay };
};

const persist = () => store.save({ ...saved, manual, hrBounds, lastPreset: target().preset });

async function loadPlan() {
    const urls = NATIVE || location.hostname.endsWith('github.io') ? [`${PLAN_URL}?t=${Date.now()}`, 'today.json'] : ['today.json'];
    for (const url of urls) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const plan = await res.json();
            planDay = plan.days?.[todayKey()] ?? null;
            planSource = url.startsWith('http') ? 'live' : 'bundled';
            queueRender();
            return;
        } catch { /* offline: try the bundled copy */ }
    }
}

// ---------- live state ----------
let monitor = null;
let state = {};
const tracker = new SplitTracker();
// Keep a finished workout on the board until its file is saved, even if the
// PM5 goes back to its menu; a new workout programmed meanwhile saves it now.
tracker.beforeReset = () => { if (session.finishedAt && !session.saved) saveSession(); };
let renderQueued = false;

const resetSession = () => { state = {}; tracker.reset(); session = newSession(); clearTimeout(saveTimer); saveTimer = null; queueRender(); };

// ---------- end-of-workout session file (#11) ----------
// Once the PM5 says the workout is over, the summary screen asks for an RPE
// (1-10, remote or keyboard). OK saves it; doing nothing saves with rpe null
// after RPE_WAIT. Either way the save waits at least SAVE_DELAY after the
// finish, so the PM5's final interval figures have arrived. The Android app
// writes the file to the TV and uploads it to the repo's workout-logs branch.
const SAVE_DELAY = 5000;
const RPE_WAIT = 120000;
const newSession = () => ({ startedAt: null, finishedAt: null, rpe: null, rpeDone: false, saved: null, gen: tracker.generation ?? 0 });
let session = newSession();     // saved: null | 'saving' | { ok, msg, name }
let saveTimer = null;
let rpeTicker = null;

function noteSession() {
    // The tracker cleared a finished workout (its file is already saving).
    if (session.gen !== (tracker.generation ?? 0)) { session = newSession(); clearTimeout(saveTimer); saveTimer = null; }
    if (!session.startedAt && tracker.pieces.length) session.startedAt = new Date().toISOString();
    if (tracker.finished && !session.finishedAt && tracker.pieces.some(p => p.splits.length)) {
        session.finishedAt = Date.now();
        scheduleSave(RPE_WAIT);
        saveDraft();
        clearInterval(rpeTicker);
        rpeTicker = setInterval(() => { if (session.saved) clearInterval(rpeTicker); queueRender(); }, 1000);
    }
    if (!tracker.pieces.length && session.startedAt) { session = newSession(); clearTimeout(saveTimer); saveTimer = null; }
    tracker.hold = !!session.finishedAt && (!session.saved || session.saved === 'saving');
}

// The session file with rpe null, kept on the TV in case the app is closed
// before an RPE is entered; the Android app uploads it then.
let draftTimer = null;
function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        if (session.saved || !window.PM5Android?.saveDraft) return;
        const summary = buildSummary(null);
        try { window.PM5Android.saveDraft(summaryLogic.fileName(summary), JSON.stringify(summary)); } catch { /* old app */ }
    }, SAVE_DELAY);
}

function buildSummary(rpe) {
    let appVersion = null;
    try { appVersion = window.PM5Android?.appVersion() ?? null; } catch { /* old app */ }
    return summaryLogic.build(tracker, target(), {
        startedAt: session.startedAt, endedAt: new Date().toISOString(),
        date: todayKey(), planSource, appVersion, rpe,
    });
}

function scheduleSave(after) {
    clearTimeout(saveTimer);
    const wait = Math.max(after, SAVE_DELAY) - (Date.now() - session.finishedAt);
    saveTimer = setTimeout(saveSession, Math.max(0, wait));
}

// OK on the summary screen: save now (or as soon as SAVE_DELAY allows).
function confirmRpe() {
    session.rpeDone = true;
    scheduleSave(0);
    queueRender();
}

function saveSession() {
    saveTimer = null;
    if (session.saved) return;
    const summary = buildSummary(session.rpe);
    const name = summaryLogic.fileName(summary);
    console.info(`[ergtv] session file ${name} rpe=${session.rpe ?? 'skipped'}`);
    if (window.PM5Android?.saveWorkout) {
        session.saved = 'saving';
        window.PM5Android.saveWorkout(name, JSON.stringify(summary));
    } else {
        session.saved = { ok: false, msg: 'not saved (desktop browser)', name };
        window.pm5tvLastSession = summary;
    }
    queueRender();
}

window.ergtvSaved = (name, ok, msg) => {
    if (session.saved !== 'saving') return;     // a newer session is up
    session.saved = { ok, msg, name };
    tracker.hold = false;
    queueRender();
};

// Diagnostics for the TV log (adb logcat -s ErgTV): one line whenever the
// PM5's workout state, interval counter, duration or programme changes,
// and a packet-rate line every 10s while connected. Answers issue #8.
const diag = {
    keys: ['workoutState', 'intervalCount', 'workoutDuration', 'workoutDurationType', 'workoutType'],
    seen: {}, n: 0, since: Date.now(),
    note(d) {
        if (d.workoutState !== undefined) this.n++;          // general-status packets
        const changed = this.keys.filter(k => d[k] !== undefined && d[k] !== this.seen[k]);
        if (changed.length) {
            for (const k of changed) this.seen[k] = d[k];
            console.info(`[ergtv] ${changed.map(k => `${k}=${d[k]}`).join(' ')} | t=${d.elapsedTime ?? ''} d=${d.distance ?? ''} rest=${state.restTime ?? ''}`);
        }
        if (d.splitIntervalTime !== undefined) {
            console.info(`[ergtv] pm5 split #${d.splitIntervalNumber ?? ''} time=${Math.round(d.splitIntervalTime * 10) / 10} dist=${d.splitIntervalDistance ?? ''} pace=${d.splitIntervalAveragePace ?? ''}`);
        }
        const dt = Date.now() - this.since;
        if (dt >= 10000) {
            console.info(`[ergtv] status ${(this.n * 1000 / dt).toFixed(1)}/s state=${state.workoutState} rest=${state.restTime ?? ''} d=${state.distance ?? ''}`);
            this.n = 0; this.since = Date.now();
        }
    },
};

const onData = (event) => {
    const d = event.data || {};
    Object.assign(state, d);
    diag.note(d);
    tracker.update(d);
    noteSession();
    queueRender();
};

const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
};

// ---------- helpers ----------
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const fmtDelta = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(1);
const markText = (chunk, mark) => chunk.kind === 'time' ? tvLogic.formatClock(mark) : `${mark}m`;

const statusFor = (pace, t) => {
    const r = tvLogic.paceStatus(pace, t.fast, t.slow);
    if (r.status !== 'none' && Math.abs(r.delta) < 0.05) return { ...r, status: 'on', delta: 0 };  // shows as ±0.0 otherwise
    return r.status === 'slow' && r.delta > 2 ? { ...r, status: 'way-slow' } : r;
};

const vsTargetCell = (pace, t) => {
    const r = statusFor(pace, t);
    if (r.status === 'none') return { text: '', status: 'none' };
    return { text: r.status === 'on' ? 'on' : fmtDelta(r.delta), status: r.status };
};

const vsLastCell = (delta) => {
    if (delta === null || !Number.isFinite(delta)) return { text: '', dir: '' };
    const dir = Math.abs(delta) < 0.25 ? 'same' : delta < 0 ? 'better' : 'worse';
    return { text: fmtDelta(delta), dir };
};

// ---------- breakdown ----------
// The PM5's programmed piece before the first stroke (on the starting
// block), or null for Just Row / nothing programmed yet.
function armedChunk() {
    if (tracker.pieces.length || tracker.finished || tracker.program.workoutDurationType === undefined) return null;
    const chunk = splitsLogic.chunkFor(tracker.program.workoutDuration, tracker.program.workoutDurationType);
    return chunk.total > 0 ? chunk : null;
}

function renderBreakdown(t, hasTarget) {
    const armed = armedChunk();
    const piece = tracker.current ?? tracker.pieces[tracker.pieces.length - 1] ?? (armed ? splitsLogic.newPiece(armed) : null);
    const prev = tracker.previousFor(piece);
    const resting = tvLogic.isRest(state.workoutState);
    const finished = tvLogic.isFinished(state.workoutState);
    const rowsEl = $('#bd-rows');
    renderRpe();

    if (!piece) {
        setText($('#bd-title'), 'Ready');
        setText($('#bd-sub'), t.preset === 'free'
            ? 'PM5 only: set any workout on the PM5 and the splits follow it'
            : 'Start rowing and the splits fill in here');
        rowsEl.replaceChildren();
        setText($('#bd-avg'), '');
        setText($('#bd-pieces'), '');
        return;
    }

    if (tracker.finished) { renderSummary(t, hasTarget); return; }
    setCols(['Split', 'Pace', 'vs target', 'vs last', 'Rate', 'HR']);
    const n = tracker.pieces.indexOf(piece) + 1;
    const { chunk } = piece;
    // A just-row piece (warm-up, cool-down) isn't scored against an
    // interval target; only Zone 2 and Just row targets apply to it.
    if (!(chunk.total > 0) && !['zone2', 'free'].includes(t.preset)) hasTarget = false;
    const lengthText = chunk.total > 0
        ? (chunk.kind === 'time' ? tvLogic.formatClock(chunk.total) : `${chunk.total}m`)
        : 'Just row';
    const title = armed && !tracker.pieces.length ? 'Ready' : finished ? 'Workout done' : resting ? `Piece ${n} done` : `Piece ${n}`;
    setText($('#bd-title'), title);
    const restText = tracker.restSeconds ? ` · ${tvLogic.formatClock(tracker.restSeconds)} rest` : '';
    const scoring = hasTarget ? '' : chunk.total > 0 ? '' : ' · not scored';
    const go = armed && !tracker.pieces.length ? ' · start rowing' : '';
    setText($('#bd-sub'), `PM5: ${lengthText}${restText} · ${chunk.kind === 'time' ? tvLogic.formatClock(chunk.size) : chunk.size + 'm'} splits${scoring}${go}`);

    const rows = splitsLogic.rowCount(piece);
    rowsEl.style.setProperty('--rows', String(Math.max(rows, 4)));

    const live = !resting && !finished && piece === tracker.current;
    const curIdx = piece.splits.length;          // index of the chunk in progress
    const frag = [];
    for (let i = 0; i < rows; i++) {
        const sp = piece.splits[i];
        const prevSp = prev?.splits?.[i];
        let cls = 'row', pace = NaN, rate, hr, ghost = false, progress = 0;
        if (sp) {
            pace = sp.pace; rate = sp.rate; hr = sp.hr;
        } else if (i === curIdx && live) {
            cls += ' current';
            pace = splitsLogic.currentPace(piece);
            progress = splitsLogic.currentProgress(piece);
            rate = state.strokeRate; hr = tvLogic.hrZone(state.heartRate, hrBounds) ? state.heartRate : undefined;
        } else {
            cls += ' future';
            ghost = true;
            pace = prevSp?.pace ?? NaN;
        }

        const row = document.createElement('div');
        row.className = cls;
        if (progress) {
            const pct = (progress * 100).toFixed(1);
            row.style.background = `linear-gradient(90deg, rgba(255,255,255,.12) ${pct}%, rgba(255,255,255,.04) ${pct}%)`;
        }
        const mark = (i + 1) * chunk.size;
        const cells = [
            ['mark', markText(chunk, chunk.total > 0 ? Math.min(mark, chunk.total) : mark)],
            ['pace', Number.isFinite(pace) ? tvLogic.formatPace(pace) : ''],
            ['vs', ''], ['vs', ''], ['rate', rate > 0 ? String(rate) : ''], ['hr', hr > 0 ? String(hr) : ''],
        ];
        const spans = cells.map(([c, text]) => {
            const s = document.createElement('span');
            s.className = c;
            s.textContent = text;
            return s;
        });
        if (!ghost && Number.isFinite(pace)) {
            if (hasTarget) {
                const vt = vsTargetCell(pace, t);
                spans[1].dataset.status = vt.status;
                spans[2].textContent = vt.text;
                spans[2].dataset.status = vt.status;
            }
            const vl = vsLastCell(prevSp && Number.isFinite(prevSp.pace) ? pace - prevSp.pace : null);
            spans[3].textContent = vl.text;
            spans[3].dataset.dir = vl.dir;
        } else if (ghost && Number.isFinite(pace)) {
            spans[3].textContent = 'last';
        }
        row.append(...spans);
        frag.push(row);
    }
    rowsEl.replaceChildren(...frag);

    // Footer: average so far, vs target and vs the last piece
    const avg = piece.done && piece.pm5Avg > 0 ? piece.pm5Avg : splitsLogic.average(piece);
    const foot = [];
    if (Number.isFinite(avg)) {
        foot.push(`Avg ${tvLogic.formatPace(avg)}`);
        if (hasTarget) {
            const r = statusFor(avg, t);
            foot.push(r.status === 'on' ? 'on target' : `${fmtDelta(r.delta)}s vs target`);
        }
        if (prev) {
            const k = piece.splits.length;
            const prevAvg = splitsLogic.average({ ...prev, splits: prev.splits.slice(0, k) });
            if (Number.isFinite(prevAvg)) foot.push(`${fmtDelta(avg - prevAvg)}s vs last piece`);
        }
    }
    setText($('#bd-avg'), foot.join('  ·  '));

    const done = tracker.pieces.filter(p => p.splits.length && (p !== tracker.current || resting || finished));
    setText($('#bd-pieces'), done.length > 1 || (done.length && piece !== done[done.length - 1])
        ? done.map((p, i) => `P${i + 1} ${tvLogic.formatPace(p.pm5Avg > 0 ? p.pm5Avg : splitsLogic.average(p))}`).join('  ')
        : '');
}

const setCols = (names) => {
    const spans = document.querySelectorAll('.bd-cols span');
    names.forEach((txt, i) => { if (spans[i]) setText(spans[i], txt); });
};

// Whole-workout view once the PM5 says it's done: one row per piece.
function renderSummary(t, hasTarget) {
    const pieces = tracker.pieces.filter(p => p.splits.length);
    const rowsEl = $('#bd-rows');
    setText($('#bd-title'), 'Workout done');
    setCols(['Piece', 'Avg', 'vs target', 'Spread', 'Rate', 'HR']);
    const sums = pieces.map((p, i) => summaryLogic.piece(p, i + 1));
    const totalD = sums.reduce((a, p) => a + p.distance, 0);
    const totalT = sums.reduce((a, p) => a + p.time, 0);
    setText($('#bd-sub'), `${pieces.length} piece${pieces.length === 1 ? '' : 's'} · ${totalD.toLocaleString()}m in ${tvLogic.formatClock(totalT)}`);
    rowsEl.style.setProperty('--rows', String(Math.max(sums.length, 6)));
    rowsEl.replaceChildren(...sums.map(p => {
        const row = document.createElement('div');
        row.className = 'row';
        const len = p.kind === 'time' ? tvLogic.formatClock(p.total) : p.kind === 'distance' ? `${p.total}m` : `${p.distance}m`;
        const cells = [
            ['mark', `P${p.n} ${len}`],
            ['pace', Number.isFinite(p.avgPace) ? tvLogic.formatPace(p.avgPace) : ''],
            ['vs', ''],
            ['vs', p.spread !== null ? `${p.spread.toFixed(1)}s` : ''],
            ['rate', p.rate ? String(p.rate) : ''],
            ['hr', p.hr ? String(p.hr) : ''],
        ];
        const spans = cells.map(([c, text]) => { const s = document.createElement('span'); s.className = c; s.textContent = text; return s; });
        if (hasTarget && p.kind !== 'just-row' && Number.isFinite(p.avgPace)) {
            const vt = vsTargetCell(p.avgPace, t);
            spans[1].dataset.status = vt.status;
            spans[2].textContent = vt.text;
            spans[2].dataset.status = vt.status;
        }
        row.append(...spans);
        return row;
    }));
    const avg = totalD > 0 ? (totalT * 500) / totalD : NaN;
    const avgs = sums.map(p => p.avgPace).filter(Number.isFinite);
    const foot = [];
    if (Number.isFinite(avg)) foot.push(`Avg ${tvLogic.formatPace(avg)}`);
    if (avgs.length > 1) foot.push(`spread ${(Math.max(...avgs) - Math.min(...avgs)).toFixed(1)}s`);
    setText($('#bd-avg'), foot.join('  ·  '));
    const sv = session.saved;
    const rpeTxt = session.rpe ? `RPE ${session.rpe} · ` : '';
    setText($('#bd-pieces'), !sv ? (session.rpeDone ? 'Saving to your log…' : '')
        : sv === 'saving' ? `${rpeTxt}Saving to your log…`
        : sv.ok ? `${rpeTxt}Saved to your log ✓` : `${rpeTxt}Not in your log yet: ${sv.msg}`);
    renderRpe();
}

// RPE picker on the summary screen, until the session file is saved.
function renderRpe() {
    const el = $('#rpe');
    const asking = tracker.finished && !!session.finishedAt && !session.saved && !session.rpeDone;
    el.hidden = !asking;
    if (!asking) return;
    const boxes = $('#rpe-scale');
    if (boxes.children.length !== 10) {
        boxes.replaceChildren(...Array.from({ length: 10 }, (_, i) => {
            const b = document.createElement('span'); b.textContent = String(i + 1); return b;
        }));
    }
    [...boxes.children].forEach((b, i) => b.classList.toggle('on', session.rpe === i + 1));
    setText($('#rpe-word'), summaryLogic.rpeWord(session.rpe));
    const left = Math.max(0, Math.ceil((RPE_WAIT - (Date.now() - session.finishedAt)) / 1000));
    setText($('#rpe-hint'), session.rpe
        ? `OK save · saves anyway in ${tvLogic.formatClock(left)}`
        : `← → or 1–0 pick · OK skip · saves without it in ${tvLogic.formatClock(left)}`);
}

// ---------- rest coaching cards (#10) ----------
const coach = { page: 0, dismissed: false, shown: false };

// ---------- PM5-only mode: Concept2 workout ideas before the first stroke ----------
let wodBucket = 1;    // index into wodLogic.BUCKETS
// Only until a workout is set on the PM5: then the board shows its splits.
const showingWods = (t) => t.preset === 'free' && !tracker.pieces.length && !tracker.finished && !armedChunk();

function renderWods(t) {
    const el = $('#wods');
    el.hidden = !showingWods(t);
    if (el.hidden) return;
    const max = wodLogic.BUCKETS[wodBucket];
    setText($('#wods-title'), `Under ${max} min`);
    setText($('#wods-page'), wodLogic.BUCKETS.map((b, i) => i === wodBucket ? `[${b}]` : String(b)).join('  '));
    $('#wods-list').replaceChildren(...wodLogic.inBucket(max).map(w => {
        const li = document.createElement('li');
        const head = document.createElement('div'); head.className = 'wod-head';
        const name = document.createElement('span'); name.textContent = w.name;
        const mins = document.createElement('span'); mins.className = 'wod-min'; mins.textContent = `~${w.min} min`;
        head.append(name, mins);
        const setup = document.createElement('div'); setup.className = 'wod-pm5';
        setup.textContent = `PM5: ${w.pm5}`;
        const how = document.createElement('div'); how.className = 'wod-how';
        how.textContent = `${w.how}${w.cut ? ' (shortened)' : ''}`;
        li.append(head, setup, how);
        return li;
    }));
}

function renderCoach(t) {
    const resting = tvLogic.isRest(state.workoutState) && !tracker.finished;
    if (!resting) { coach.dismissed = false; coach.page = 0; }
    const show = coachLogic.visible({ resting, restSeconds: tracker.restSeconds, restLeft: state.restTime, dismissed: coach.dismissed });
    coach.shown = show;
    const box = $('#coach');
    box.hidden = !show;
    if (!show) return;
    const last = tracker.pieces[tracker.pieces.length - 1] ?? null;
    const cards = coachLogic.cards({ piece: last, target: t, notes: planDay?.notes ?? [], fmt: tvLogic.formatPace });
    coach.page = ((coach.page % cards.length) + cards.length) % cards.length;
    const card = cards[coach.page];
    setText($('#coach-title'), card.title);
    setText($('#coach-page'), `${coach.page + 1} / ${cards.length}`);
    const ul = $('#coach-lines');
    const html = card.lines.map(l => `<li>${l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</li>`).join('');
    if (ul.innerHTML !== html) ul.innerHTML = html;
}

// ---------- live strip ----------
function renderLive(t, hasTarget) {
    const s = state;
    const finished = tracker.finished;
    const resting = tvLogic.isRest(s.workoutState) || finished;
    const splitTile = $('.live-tile.split');

    if (finished) {
        const done = tracker.pieces.filter(p => p.splits.length).map((p, i) => summaryLogic.piece(p, i + 1));
        const dist = done.reduce((a, p) => a + p.distance, 0), time = done.reduce((a, p) => a + p.time, 0);
        splitTile.dataset.status = 'none';
        setText($('#split-label'), 'Workout avg');
        setText($('#pace'), dist > 0 ? tvLogic.formatPace((time * 500) / dist) : '-:--.-');
        setText($('#pace-delta'), dist > 0 ? `${dist.toLocaleString()}m in ${tvLogic.formatClock(time)}` : '');
    } else if (resting) {
        splitTile.dataset.status = 'rest';
        setText($('#split-label'), 'Rest');
        setText($('#pace'), tvLogic.formatClock(s.restTime));
        setText($('#pace-delta'), hasTarget ? `Next at ${tvLogic.formatPace(t.fast)}–${tvLogic.formatPace(t.slow)}` : '');
    } else {
        const pace = s.currentPace ?? s.pace;
        const r = statusFor(pace, t);
        splitTile.dataset.status = r.status;
        setText($('#split-label'), 'Split now');
        setText($('#pace'), tvLogic.formatPace(pace));
        setText($('#pace-delta'), !hasTarget || r.status === 'none' ? ''
            : r.status === 'on' ? 'On target' : `${fmtDelta(r.delta)}s vs target`);
    }

    const rate = s.strokeRate ?? s.cadence;
    $('.live-tile.rate').dataset.status = resting ? 'none' : tvLogic.rateStatus(rate, t.rateLo, t.rateHi);
    setText($('#rate'), !resting && rate > 0 ? String(rate) : '--');
    setText($('#rate-target'), Number.isFinite(t.rateLo) ? `${t.rateLo}–${t.rateHi}` : '');

    const zone = tvLogic.hrZone(s.heartRate, hrBounds);
    $('.live-tile.hr').dataset.zone = String(zone);
    setText($('#hr'), zone ? String(s.heartRate) : '--');
    setText($('#hr-zone'), zone ? `Zone ${zone}` : 'No strap');

    const left = resting ? null : tvLogic.remaining(s);
    const lastPiece = tracker.pieces[tracker.pieces.length - 1];
    if (finished) {
        const total = tracker.pieces.filter(p => p.splits.length).reduce((a, p, i) => a + summaryLogic.piece(p, i + 1).distance, 0);
        setText($('#togo-label'), 'Total work');
        setText($('#togo'), `${total.toLocaleString()}m`);
    } else if (resting && lastPiece?.last) {
        // the PM5 counts rest metres from the flywheel spinning down; show
        // the piece just rowed instead
        const p = lastPiece;
        const meters = p.chunk.kind === 'distance' && p.chunk.total > 0 ? p.chunk.total : Math.floor(p.last.d - p.origin.d);
        setText($('#togo-label'), `Piece ${tracker.pieces.length}`);
        setText($('#togo'), `${meters.toLocaleString()}m`);
    } else if (left?.kind === 'distance') {
        setText($('#togo-label'), 'Meters to go');
        setText($('#togo'), Math.ceil(left.value).toLocaleString());
    } else if (left?.kind === 'time') {
        setText($('#togo-label'), 'Time to go');
        setText($('#togo'), tvLogic.formatClock(Math.ceil(left.value)));
    } else {
        setText($('#togo-label'), 'Meters');
        setText($('#togo'), Number.isFinite(s.distance) ? Math.floor(s.distance).toLocaleString() : '0');
    }

    const gap = hasTarget && !resting ? tvLogic.boatGap(s.distance, s.elapsedTime, tvLogic.bandMid(t.fast, t.slow)) : null;
    setText($('#boat'), gap === null ? '' : Math.round(gap) === 0 ? 'Level with target boat'
        : `${Math.abs(Math.round(gap))}m ${gap > 0 ? 'ahead of' : 'behind'} target boat`);
}

function render() {
    const t = target();
    const hasTarget = Number.isFinite(t.fast) && Number.isFinite(t.slow);
    const src = t.fromPlan ? (planSource === 'live' ? 'Plan' : 'Plan (saved copy)') : manual?.preset ? 'Remote' : 'Default';
    setText($('#target-label'), `${src}: ${t.label ?? ''}` + (t.shift ? ` (${t.shift > 0 ? '+' : '−'}${Math.abs(t.shift).toFixed(1)}s)` : ''));
    const piece = tracker.current ?? tracker.pieces[tracker.pieces.length - 1];
    const chunk = piece?.chunk ?? (tracker.program.workoutDurationType !== undefined
        ? splitsLogic.chunkFor(tracker.program.workoutDuration, tracker.program.workoutDurationType) : null);
    const diff = t.fromPlan ? tvLogic.planMismatch(planDay?.piece, chunk, tracker.restSeconds) : [];
    const warn = $('#plan-warn');
    warn.hidden = !diff.length;
    setText(warn, diff.length ? `Doesn't match the plan: ${diff.join(' · ')}` : '');
    setText($('#target-text'), hasTarget
        ? `${tvLogic.formatPace(t.fast)}–${tvLogic.formatPace(t.slow)}` + (Number.isFinite(t.rateLo) ? ` · r${t.rateLo}–${t.rateHi}` : '')
        : 'No target');
    renderBreakdown(t, hasTarget);
    renderLive(t, hasTarget);
    renderCoach(t);
    renderWods(t);
}

// ---------- connection status ----------
function showConn(title, sub) {
    const box = $('#conn');
    if (!title) { box.hidden = true; return; }
    box.hidden = false;
    setText($('#conn-title'), title);
    setText($('#conn-sub'), sub ?? '');
}

function onNativeState(e) {
    const { state: st, name, message } = e.data || {};
    if (st === 'scanning') showConn('Looking for your PM5…', 'On the PM5: More Options → Turn Wireless ON');
    else if (st === 'connecting') showConn(`Connecting to ${name || 'PM5'}…`);
    else if (st === 'connected') showConn(null);
    else if (st === 'disconnected') showConn('PM5 disconnected', 'Reconnecting…');
    else if (st === 'error') showConn('Bluetooth problem', message || '');
}

const wire = (m) => {
    monitor = m;
    m.addEventListener('connected', () => {
        const events = m.MESSAGE_EVENTS ?? m.constructor.MESSAGE_EVENTS;
        for (const type of events) m.addEventListener(type, onData);
        if (!NATIVE) { showConn(null); $('#connect').textContent = 'Disconnect'; scheduleToolbarHide(); }
    });
    m.addEventListener('disconnected', () => {
        if (!NATIVE) { $('#connect').textContent = 'Connect'; showToolbar(); }
    });
    m.addEventListener('native-state', onNativeState);
    initWakeLock(m);
};

function startNative() {
    const m = new PM5Native();
    wire(m);
    showConn('Starting Bluetooth…');
    m.connect().catch(err => showConn('Bluetooth problem', err.message));
    try { setText($('#help-version'), `App ${window.PM5Android.appVersion()}`); } catch { /* old app */ }
}

function startWeb(kind) {
    if (monitor?.connected()) { monitor.disconnect(); return; }
    resetSession();
    let m;
    if (kind === 'mock') {
        m = new PM5Mock({
            loadSamples: () => csvSource.loadFromUrl('../lib/mock-data/concept2-result-44214428.csv'),
            emulate: 'ble', speed: Number(params.get('speed')) || 4, loop: false,
        });
        // The demo recording has no programmed piece; pretend it's a 2000m.
        m.addEventListener('connected', () => onData({ data: { workoutDuration: 2000, workoutDurationType: 0x80, workoutType: 3 } }));
    } else {
        if (!navigator.bluetooth) { showConn('No Bluetooth in this browser', 'Use Chrome or Edge'); return; }
        m = new PM5();
    }
    wire(m);
    m.connect()
        .then(() => { if (!m.connected()) $('#connect').textContent = 'Connect'; })
        .catch(err => showConn('Could not connect', err.message));
}

// ---------- remote / keyboard ----------
let helpTimer = null;
function toast(text) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; $('#board').appendChild(el); }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

function changePreset(dir) {
    const cur = target().preset;
    const i = Math.max(0, PRESET_ORDER.indexOf(cur));
    const next = PRESET_ORDER[(i + dir + PRESET_ORDER.length) % PRESET_ORDER.length];
    manual = { date: todayKey(), preset: next, shift: 0 };
    persist();
    toast(tvLogic.PRESETS[next].label);
    queueRender();
}

function shiftTarget(delta) {
    const t = target();
    if (!Number.isFinite(t.fast)) return;
    manual = { date: todayKey(), preset: manual?.preset ?? null, shift: (manual?.shift ?? 0) + delta };
    persist();
    const nt = target();
    toast(`Target ${tvLogic.formatPace(nt.fast)}–${tvLogic.formatPace(nt.slow)}`);
    queueRender();
}

// Locked while a piece is under way, so a bumped remote can't change the
// target mid-piece. Free during rest, before the first stroke and after.
const arrowsLocked = () => {
    const p = tracker.current;
    return !!p && tracker.working && !tracker.finished && !!p.last && (p.last.d - p.origin.d) > 20;
};

function onKey(e) {
    nudgeToolbar();
    if (e.key.startsWith('Arrow') && arrowsLocked()) {
        toast('Remote locked while rowing. Change it in the rest.');
        e.preventDefault();
        return;
    }
    // Summary screen: arrows and digits pick the RPE, OK saves the session.
    if (tracker.finished && session.finishedAt && !session.saved && !session.rpeDone) {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        const digit = summaryLogic.rpeFromKey(e.key);
        if (step || digit || e.key === 'Enter') {
            if (step) session.rpe = summaryLogic.stepRpe(session.rpe, step);
            else if (digit) session.rpe = digit;
            else confirmRpe();
            queueRender(); e.preventDefault(); return;
        }
    }
    // During a long rest the arrows flip coaching cards and OK hides them.
    const longRest = tvLogic.isRest(state.workoutState) && !tracker.finished
        && coachLogic.visible({ resting: true, restSeconds: tracker.restSeconds, restLeft: state.restTime, dismissed: false });
    if (coach.shown && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        coach.page += e.key === 'ArrowRight' ? 1 : -1;
        queueRender(); e.preventDefault(); return;
    }
    if (longRest && e.key === 'Enter') {
        coach.dismissed = !coach.dismissed;
        queueRender(); e.preventDefault(); return;
    }
    switch (e.key) {
        case 'ArrowLeft': changePreset(-1); break;
        case 'ArrowRight': changePreset(1); break;
        case 'ArrowUp':
            if (showingWods(target())) { wodBucket = Math.max(0, wodBucket - 1); queueRender(); }
            else shiftTarget(-0.5);                   // faster
            break;
        case 'ArrowDown':
            if (showingWods(target())) { wodBucket = Math.min(wodLogic.BUCKETS.length - 1, wodBucket + 1); queueRender(); }
            else shiftTarget(0.5);                    // slower
            break;
        case 'Enter': {
            const h = $('#help');
            h.hidden = !h.hidden;
            clearTimeout(helpTimer);
            if (!h.hidden) helpTimer = setTimeout(() => { h.hidden = true; }, 8000);
            break;
        }
        case 'f': if (!NATIVE) toggleFullscreen(); break;
        default: return;
    }
    e.preventDefault();
}

// ---------- desktop toolbar ----------
let hideTimer = null;
const showToolbar = () => { document.body.classList.remove('toolbar-hidden'); clearTimeout(hideTimer); };
const scheduleToolbarHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        if (monitor?.connected() && !$('#toolbar').matches(':hover')) document.body.classList.add('toolbar-hidden');
    }, 4000);
};
const nudgeToolbar = () => { if (NATIVE) return; showToolbar(); if (monitor?.connected()) scheduleToolbarHide(); };
const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
};

// ---------- startup ----------
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('keydown', onKey);
    loadPlan();
    render();

    if (NATIVE) {
        startNative();
        return;
    }

    document.body.classList.add('has-toolbar');
    $('#toolbar').hidden = false;
    document.addEventListener('mousemove', nudgeToolbar);
    $('#fullscreen').addEventListener('click', toggleFullscreen);
    $('#connect').addEventListener('click', () => startWeb($('#transport').value));
    if (!navigator.bluetooth) $('#transport').value = 'mock';
    showConn('Click Connect to pair with your PM5', 'Or pick Demo workout to try it');
    if (params.has('demo')) { $('#transport').value = 'mock'; startWeb('mock'); }
});

// Console/test hook: pm5tv.inject({ elapsedTime: 10, distance: 45 })
window.pm5tv = { inject: data => onData({ data }), reset: resetSession, tracker };
