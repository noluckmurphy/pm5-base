// TV display: one PM5 connection, a few huge numbers, coloured against the
// day's target. All the maths lives in tv-logic.js (tested); this file is
// DOM glue, same category as example/app.js.

const $ = sel => document.querySelector(sel);

const TRANSPORTS = {
    bluetooth: { label: 'Bluetooth', build: () => new PM5(),    supported: () => !!navigator.bluetooth },
    usb:       { label: 'USB',       build: () => new PM5HID(), supported: () => !!navigator.hid },
    mock: {
        label: 'Demo workout',
        build: () => new PM5Mock({
            loadSamples: () => csvSource.loadFromUrl('../lib/mock-data/concept2-result-44214428.csv'),
            emulate: 'ble',
            speed: Number(settings.mockSpeed) || 1,
            loop: true,
        }),
        supported: () => true,
    },
};

const INTERVAL_WORKOUTS = [6, 7, 8, 9, 12];
const SPLITS_SHOWN = 10;
const STORAGE_KEY = 'pm5-tv-settings-v1';

// ---------- settings (per-browser convenience, safe if storage is blocked) ----------

const DEFAULT_SETTINGS = {
    preset: 'threshold',
    overrides: {},                       // { fast, slow, rateLo, rateHi } for today only
    hrBounds: [...tvLogic.DEFAULT_HR_BOUNDS],
    mockSpeed: 4,
    transport: 'bluetooth',
};

const loadSettings = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return { ...DEFAULT_SETTINGS, ...saved, overrides: { ...(saved.overrides || {}) } };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
};
const saveSettings = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private window etc. */ }
};

let settings = loadSettings();

const target = () => {
    const p = tvLogic.PRESETS[settings.preset] ?? tvLogic.PRESETS.free;
    const o = settings.overrides || {};
    const pick = k => Number.isFinite(o[k]) ? o[k] : p[k];
    return { label: p.label, fast: pick('fast'), slow: pick('slow'), rateLo: pick('rateLo'), rateHi: pick('rateHi') };
};

// ---------- live state ----------

let monitor = null;
let state = {};
let splits = [];        // [{ n, pace, rate, hr }]
let lastWorkoutState = null;
let renderQueued = false;

const resetSession = () => {
    state = {};
    splits = [];
    lastWorkoutState = null;
    queueRender();
};

const onData = (event) => {
    const d = event.data || {};

    // New workout after one finished: start the splits strip fresh.
    if (d.workoutState !== undefined) {
        if (d.workoutState === 0 && lastWorkoutState !== null && lastWorkoutState !== 0) {
            splits = [];
        }
        lastWorkoutState = d.workoutState;
    }

    if (d.splitIntervalAveragePace !== undefined && d.splitIntervalNumber !== undefined) {
        const entry = {
            n: d.splitIntervalNumber,
            pace: d.splitIntervalAveragePace,
            rate: d.splitIntervalAverageStrokeRate,
            hr: d.splitIntervalWorkHeartrate,
        };
        if (splits.length && entry.n < splits[splits.length - 1].n) splits = []; // counter went back: new workout
        const i = splits.findIndex(s => s.n === entry.n);
        if (i >= 0) splits[i] = entry; else splits.push(entry);
    }

    Object.assign(state, d);
    queueRender();
};

const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
};

// ---------- rendering ----------

const setText = (sel, text) => {
    const node = $(sel);
    if (node.textContent !== text) node.textContent = text;
};

const paceTileStatus = (pace, t) => {
    const r = tvLogic.paceStatus(pace, t.fast, t.slow);
    if (r.status === 'slow' && r.delta > 2) return { ...r, tile: 'way-slow' };
    return { ...r, tile: r.status };
};

const deltaText = (r) => {
    if (r.status === 'on') return 'On target';
    if (r.status === 'fast') return `${Math.abs(r.delta).toFixed(1)}s faster than target`;
    if (r.status === 'slow') return `${r.delta.toFixed(1)}s slower than target`;
    return '';
};

const render = () => {
    const t = target();
    const hasTarget = Number.isFinite(t.fast) && Number.isFinite(t.slow);
    const s = state;

    // Split
    const pace = s.currentPace ?? s.pace;
    const r = paceTileStatus(pace, t);
    $('.tile.split').dataset.status = r.tile;
    setText('#pace', tvLogic.formatPace(pace));
    setText('#pace-delta', hasTarget ? deltaText(r) : '');

    // Pace boat
    const boat = $('#boat');
    const gap = hasTarget ? tvLogic.boatGap(s.distance, s.elapsedTime, tvLogic.bandMid(t.fast, t.slow)) : null;
    const working = !tvLogic.isRest(s.workoutState) && !tvLogic.isFinished(s.workoutState);
    if (gap === null || !working) {
        boat.hidden = true;
    } else {
        boat.hidden = false;
        const clamped = Math.max(-25, Math.min(25, gap));
        $('#boat-marker').style.left = `${50 + clamped * 2}%`;
        const m = Math.round(Math.abs(gap));
        boat.dataset.side = m === 0 ? 'level' : gap > 0 ? 'ahead' : 'behind';
        setText('#boat-text', m === 0 ? 'Level with the pace boat' : `${m} m ${gap > 0 ? 'ahead of' : 'behind'} the pace boat`);
    }

    // Piece number (interval workouts only)
    const isIntervals = INTERVAL_WORKOUTS.includes(s.workoutType);
    setText('#piece-label', isIntervals && Number.isFinite(s.intervalCount) ? `Piece ${s.intervalCount + 1}` : '');

    // Rate
    const rate = s.strokeRate ?? s.cadence;
    $('.tile.rate').dataset.status = tvLogic.rateStatus(rate, t.rateLo, t.rateHi);
    setText('#rate', rate > 0 ? String(rate) : '--');
    setText('#rate-target', Number.isFinite(t.rateLo) ? `${t.rateLo}–${t.rateHi}` : '');

    // Heart rate
    const hr = s.heartRate;
    const zone = tvLogic.hrZone(hr, settings.hrBounds);
    $('.tile.hr').dataset.zone = String(zone);
    setText('#hr', zone ? String(hr) : '--');
    setText('#hr-zone', zone ? `Zone ${zone}` : 'No strap');

    // Distance / time, switching to "to go" when the PM5 says how long the piece is
    const left = tvLogic.remaining(s);
    const dist = s.distance ?? s.workDistance;
    if (left?.kind === 'distance') {
        setText('#dist-label', 'Meters to go');
        setText('#dist', Math.ceil(left.value).toLocaleString());
    } else {
        setText('#dist-label', 'Meters');
        setText('#dist', Number.isFinite(dist) ? Math.floor(dist).toLocaleString() : '0');
    }
    const elapsed = s.elapsedTime ?? s.workTime;
    if (left?.kind === 'time') {
        setText('#time-label', 'Time to go');
        setText('#time', tvLogic.formatClock(Math.ceil(left.value)));
    } else {
        setText('#time-label', 'Time');
        setText('#time', tvLogic.formatClock(elapsed));
    }

    // The PM5 sends its own average; the demo workout doesn't, so fall back to time/distance.
    const avg = s.averagePace > 0 ? s.averagePace
        : (dist > 0 && elapsed > 0 ? (elapsed * 500) / dist : NaN);
    setText('#avg', tvLogic.formatPace(avg));
    const watts = s.strokePower ?? s.averagePower ?? s.power;
    setText('#watts', watts > 0 ? String(Math.round(watts)) : '--');

    renderSplits(t);
    renderBanner(t);
};

const renderSplits = (t) => {
    const strip = $('#splits');
    const shown = splits.slice(-SPLITS_SHOWN);
    const key = JSON.stringify(shown) + t.fast + t.slow;
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;
    strip.replaceChildren(...shown.map(sp => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.dataset.status = tvLogic.paceStatus(sp.pace, t.fast, t.slow).status;
        const n = document.createElement('div');
        n.className = 'n';
        n.textContent = `#${sp.n}${sp.rate ? ` · r${sp.rate}` : ''}`;
        const p = document.createElement('div');
        p.className = 'p';
        p.textContent = tvLogic.formatPace(sp.pace);
        chip.append(n, p);
        return chip;
    }));
};

const renderBanner = (t) => {
    const s = state;
    const banner = $('#banner');
    const last = splits[splits.length - 1];
    const lastText = last
        ? `Last piece ${tvLogic.formatPace(last.pace)}${last.rate ? ` at r${last.rate}` : ''}`
        : '';

    if (tvLogic.isRest(s.workoutState)) {
        banner.hidden = false;
        setText('#banner-title', `Rest ${tvLogic.formatClock(s.restTime)}`);
        setText('#banner-sub', [lastText, Number.isFinite(t.fast) ? `Next: ${tvLogic.formatPace(t.fast)}–${tvLogic.formatPace(t.slow)}` : '']
            .filter(Boolean).join('  ·  '));
    } else if (tvLogic.isFinished(s.workoutState)) {
        banner.hidden = false;
        setText('#banner-title', 'Done');
        const avgs = splits.map(x => x.pace).filter(x => x > 0);
        const avg = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : s.averagePace;
        setText('#banner-sub', `Average ${tvLogic.formatPace(avg)}  ·  send Claude the photo and your RPE`);
    } else {
        banner.hidden = true;
    }
};

// ---------- session picker / settings dialog ----------

const renderTargetText = () => {
    const t = target();
    const parts = [];
    if (Number.isFinite(t.fast)) parts.push(`Target ${tvLogic.formatPace(t.fast)}–${tvLogic.formatPace(t.slow)}`);
    if (Number.isFinite(t.rateLo)) parts.push(`rate ${t.rateLo}–${t.rateHi}`);
    if (Object.keys(settings.overrides || {}).length) parts.push('(custom)');
    setText('#target-text', parts.join(' · '));
};

const fillSettingsForm = () => {
    const t = target();
    $('#set-fast').value = Number.isFinite(t.fast) ? tvLogic.formatPace(t.fast) : '';
    $('#set-slow').value = Number.isFinite(t.slow) ? tvLogic.formatPace(t.slow) : '';
    $('#set-rate-lo').value = Number.isFinite(t.rateLo) ? t.rateLo : '';
    $('#set-rate-hi').value = Number.isFinite(t.rateHi) ? t.rateHi : '';
    ['#set-z2', '#set-z3', '#set-z4', '#set-z5'].forEach((sel, i) => { $(sel).value = settings.hrBounds[i]; });
    $('#set-mock-speed').value = String(settings.mockSpeed);
};

const readSettingsForm = () => {
    const p = tvLogic.PRESETS[settings.preset] ?? tvLogic.PRESETS.free;
    const o = {};
    const fast = tvLogic.parsePace($('#set-fast').value);
    const slow = tvLogic.parsePace($('#set-slow').value);
    const rateLo = Number($('#set-rate-lo').value);
    const rateHi = Number($('#set-rate-hi').value);
    // Only keep values that differ from the preset, so changing session type
    // later isn't silently overridden by numbers that were never edited.
    const differs = (a, b) => Number.isFinite(a) && a > 0 && a !== b;
    if (differs(fast, p.fast)) o.fast = fast;
    if (differs(slow, p.slow)) o.slow = slow;
    if ($('#set-rate-lo').value !== '' && differs(rateLo, p.rateLo)) o.rateLo = rateLo;
    if ($('#set-rate-hi').value !== '' && differs(rateHi, p.rateHi)) o.rateHi = rateHi;
    settings.overrides = o;

    const bounds = ['#set-z2', '#set-z3', '#set-z4', '#set-z5'].map(sel => Number($(sel).value));
    if (bounds.every((b, i) => Number.isFinite(b) && b > 0 && (i === 0 || b > bounds[i - 1]))) {
        settings.hrBounds = bounds;
    }
    settings.mockSpeed = Number($('#set-mock-speed').value) || 1;
    monitor?.setSpeed?.(settings.mockSpeed);
    saveSettings();
    renderTargetText();
    queueRender();
};

// ---------- connection ----------

const setStatus = text => setText('#status', text);

const cbConnecting = () => {
    $('#connect').textContent = 'Connecting…';
    $('#connect').disabled = true;
    $('#transport').disabled = true;
    setStatus('Pick the PM5 in the browser popup');
};

const cbConnected = () => {
    $('#connect').textContent = 'Disconnect';
    $('#connect').disabled = false;
    setStatus('Connected');
    document.body.dataset.connected = 'true';
    const events = monitor.MESSAGE_EVENTS ?? monitor.constructor.MESSAGE_EVENTS;
    for (const type of events) monitor.addEventListener(type, onData);
    scheduleToolbarHide();
};

const cbDisconnected = () => {
    $('#connect').textContent = 'Connect';
    $('#connect').disabled = false;
    $('#transport').disabled = false;
    delete document.body.dataset.connected;
    showToolbar();
    setStatus(monitor ? 'Disconnected' : '');
    monitor = null;
};

const connect = () => {
    if (monitor?.connected()) { monitor.disconnect(); return; }

    const t = TRANSPORTS[$('#transport').value];
    if (!t.supported()) {
        setStatus(`${t.label} isn't available in this browser. Use Chrome or Edge.`);
        return;
    }
    resetSession();
    monitor = t.build();
    monitor.addEventListener('connecting', cbConnecting);
    monitor.addEventListener('connected', cbConnected);
    monitor.addEventListener('disconnected', cbDisconnected);
    initWakeLock(monitor);

    monitor.connect()
        .then(() => { if (!monitor?.connected()) cbDisconnected(); })   // picker cancelled
        .catch((error) => {
            console.log(error);
            cbDisconnected();
            setStatus(error.message);
        });
};

// ---------- toolbar auto-hide ----------

let hideTimer = null;
const showToolbar = () => {
    document.body.classList.remove('toolbar-hidden');
    clearTimeout(hideTimer);
};
const scheduleToolbarHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        if (document.body.dataset.connected && !$('#settings').open && !$('#toolbar').matches(':hover')) {
            document.body.classList.add('toolbar-hidden');
        }
    }, 4000);
};
const nudgeToolbar = () => { showToolbar(); if (document.body.dataset.connected) scheduleToolbarHide(); };

const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
};

// ---------- startup ----------

document.addEventListener('DOMContentLoaded', () => {
    // Session picker
    const presetSel = $('#preset');
    for (const [id, p] of Object.entries(tvLogic.PRESETS)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = p.label;
        presetSel.appendChild(opt);
    }
    presetSel.value = tvLogic.PRESETS[settings.preset] ? settings.preset : 'threshold';
    presetSel.addEventListener('change', () => {
        settings.preset = presetSel.value;
        settings.overrides = {};
        saveSettings();
        renderTargetText();
        queueRender();
    });

    // Transport picker
    const transportSel = $('#transport');
    for (const [id, t] of Object.entries(TRANSPORTS)) {
        const opt = transportSel.querySelector(`option[value="${id}"]`);
        if (opt && !t.supported()) { opt.disabled = true; opt.textContent += ' (not in this browser)'; }
    }
    const preferred = TRANSPORTS[settings.transport]?.supported() ? settings.transport : 'mock';
    transportSel.value = preferred;
    transportSel.addEventListener('change', () => { settings.transport = transportSel.value; saveSettings(); });

    $('#connect').addEventListener('click', connect);
    $('#fullscreen').addEventListener('click', toggleFullscreen);

    // Settings dialog
    const dlg = $('#settings');
    $('#settings-open').addEventListener('click', () => { fillSettingsForm(); dlg.showModal(); });
    $('#settings-reset').addEventListener('click', (e) => {
        e.preventDefault();
        settings.overrides = {};
        settings.hrBounds = [...tvLogic.DEFAULT_HR_BOUNDS];
        fillSettingsForm();
    });
    dlg.addEventListener('close', () => { if (dlg.returnValue === 'ok') readSettingsForm(); nudgeToolbar(); });

    // Keyboard: F = full screen, S = settings
    document.addEventListener('keydown', (e) => {
        nudgeToolbar();
        if (dlg.open || e.target.matches('input, select')) return;
        if (e.key === 'f') toggleFullscreen();
        if (e.key === 's') { fillSettingsForm(); dlg.showModal(); }
    });
    document.addEventListener('mousemove', nudgeToolbar);

    renderTargetText();
    render();
});

// Lets a test page (or the browser console) feed in fake PM5 data:
//   pm5tv.inject({ currentPace: 115.8, strokeRate: 25, heartRate: 150 })
window.pm5tv = {
    inject: data => onData({ data }),
    reset: resetSession,
};
