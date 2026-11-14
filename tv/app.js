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
let renderQueued = false;

const resetSession = () => { state = {}; tracker.reset(); queueRender(); };

const onData = (event) => {
    const d = event.data || {};
    Object.assign(state, d);
    tracker.update(d);
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
function renderBreakdown(t, hasTarget) {
    const piece = tracker.current ?? tracker.pieces[tracker.pieces.length - 1] ?? null;
    const prev = tracker.previousFor(piece);
    const resting = tvLogic.isRest(state.workoutState);
    const finished = tvLogic.isFinished(state.workoutState);
    const rowsEl = $('#bd-rows');

    if (!piece) {
        setText($('#bd-title'), 'Ready');
        setText($('#bd-sub'), 'Start rowing and the splits fill in here');
        rowsEl.replaceChildren();
        setText($('#bd-avg'), '');
        setText($('#bd-pieces'), '');
        return;
    }

    const n = tracker.pieces.indexOf(piece) + 1;
    const { chunk } = piece;
    // A just-row piece (warm-up, cool-down) isn't scored against an
    // interval target; only Zone 2 and Just row targets apply to it.
    if (!(chunk.total > 0) && !['zone2', 'free'].includes(t.preset)) hasTarget = false;
    const lengthText = chunk.total > 0
        ? (chunk.kind === 'time' ? tvLogic.formatClock(chunk.total) : `${chunk.total}m`)
        : 'Just row';
    const title = finished ? 'Workout done' : resting ? `Piece ${n} done` : `Piece ${n}`;
    setText($('#bd-title'), title);
    const restText = tracker.restSeconds ? ` · ${tvLogic.formatClock(tracker.restSeconds)} rest` : '';
    const scoring = hasTarget ? '' : chunk.total > 0 ? '' : ' · not scored';
    setText($('#bd-sub'), `PM5: ${lengthText}${restText} · ${chunk.kind === 'time' ? tvLogic.formatClock(chunk.size) : chunk.size + 'm'} splits${scoring}`);

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

// ---------- live strip ----------
function renderLive(t, hasTarget) {
    const s = state;
    const resting = tvLogic.isRest(s.workoutState);
    const splitTile = $('.live-tile.split');

    if (resting) {
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
    if (resting && lastPiece?.last) {
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
    switch (e.key) {
        case 'ArrowLeft': changePreset(-1); break;
        case 'ArrowRight': changePreset(1); break;
        case 'ArrowUp': shiftTarget(-0.5); break;     // faster
        case 'ArrowDown': shiftTarget(0.5); break;    // slower
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
