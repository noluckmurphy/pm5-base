// Averages audit: for every kind of PM5 workout, the piece average must be
// total time over total distance, never one split's pace, a stroke pace, or
// a plain mean of rows of different lengths. (Kyle's 500m on 2026-11-15
// showed the last 100m split, 1:36.0, as the piece average of a 1:40.4.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { splitsLogic: S, SplitTracker } = req('../tv/splits.js');
const { summaryLogic: SM } = req('../tv/summary.js');

const near = (a, b, tol = 0.25, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

// Row one piece through the tracker at `paceAt(d)` sec/500m, sending the
// PM5's own split reports every `pm5Split` (metres or seconds) the way a
// single piece does, with its per-split average pace in a second message.
// Returns the true time and distance rowed.
function rowPiece(tr, { kind, total, paceAt, pm5Split, state = 1, step = 0.25 }) {
    let t = 0, d = 0, nextSplit = pm5Split, n = 0, lastT = 0, lastD = 0;
    const end = () => (kind === 'distance' ? d >= total : t >= total);
    while (!end()) {
        const pace = paceAt(d, t);
        let dt = step;
        if (kind === 'time' && t + dt > total) dt = total - t;
        let dd = (dt * 500) / pace;
        if (kind === 'distance' && d + dd > total) { dd = total - d; dt = (dd * pace) / 500; }
        t += dt; d += dd;
        if (!end()) tr.update({ elapsedTime: t, distance: d, strokeRate: 28, heartRate: 150, workoutState: state });
        const pos = kind === 'distance' ? d : t;
        if (pm5Split && pos >= nextSplit - 1e-9 && (!total || nextSplit < total)) {
            n++;
            tr.update({ splitIntervalTime: t - lastT, splitIntervalDistance: d - lastD, splitIntervalNumber: n });
            tr.update({ splitIntervalAveragePace: ((t - lastT) * 500) / (d - lastD), splitIntervalNumber: n });
            lastT = t; lastD = d; nextSplit += pm5Split;
        }
    }
    return { t, d, n, lastT, lastD };
}

const varying = (d) => 100 + 6 * Math.sin(d / 37);   // uneven pace, roughly 1:34-1:46

function checkPiece(p, truth, label) {
    const want = (truth.t * 500) / truth.d;
    near(S.average(p), want, 0.3, `${label} splitsLogic.average`);
    const sum = SM.piece(p, 1);
    near(sum.avgPace, want, 0.3, `${label} summary avgPace`);
    near(sum.time, truth.t, 1, `${label} summary time`);
    near(sum.distance, truth.d, 3, `${label} summary distance`);
    if (p.pm5Avg > 0) near(p.pm5Avg, want, 0.3, `${label} pm5Avg`);
}

test('single distance 500m (100m splits): last split arrives after the finish', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 1 });
    const truth = rowPiece(tr, { kind: 'distance', total: 500, paceAt: varying, pm5Split: 100 });
    tr.update({ workoutState: 10 });
    tr.update({ splitIntervalTime: truth.t - truth.lastT, splitIntervalDistance: truth.d - truth.lastD, splitIntervalNumber: truth.n + 1 });
    tr.update({ splitIntervalAveragePace: 96, splitIntervalNumber: truth.n + 1 });
    checkPiece(tr.pieces[0], truth, '500m');
    assert.equal(tr.pieces[0].splits.length, 5);
});

test('single distance 1200m: the short last row (200m) is weighted by its length', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 1200, workoutDurationType: 0x80, workoutState: 1 });
    const truth = rowPiece(tr, { kind: 'distance', total: 1200, paceAt: d => (d > 1000 ? 90 : 110) });
    tr.update({ workoutState: 10 });
    const p = tr.pieces[0];
    assert.equal(p.splits.at(-1).mark, 1200);
    checkPiece(p, truth, '1200m');
});

test('single time 10:00 with 2:00 PM5 splits', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 600, workoutDurationType: 0, workoutState: 1 });
    const truth = rowPiece(tr, { kind: 'time', total: 600, paceAt: varying, pm5Split: 120 });
    tr.update({ workoutState: 10 });
    const p = tr.pieces[0];
    assert.equal(p.chunk.size, 120);
    assert.equal(p.splits.length, 5);
    checkPiece(p, truth, '10:00');
});

test('single time 25:00: the short last row (1:00) is weighted by its length', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 1500, workoutDurationType: 0, workoutState: 1 });
    const truth = rowPiece(tr, { kind: 'time', total: 1500, paceAt: (d, t) => (t > 1440 ? 100 : 130) });
    tr.update({ workoutState: 10 });
    const p = tr.pieces[0];
    assert.equal(p.splits.at(-1).mark, 1500);
    checkPiece(p, truth, '25:00');
});

test('intervals 3 × 1000m / rest: each piece gets its own PM5 interval average, not a split or the next one', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 1000, workoutDurationType: 0x80, workoutState: 5 });
    const truths = [];
    for (let i = 0; i < 3; i++) {
        const base = 102 + i * 2;
        const truth = rowPiece(tr, { kind: 'distance', total: 1000, state: 5, paceAt: d => base + (d > 900 ? -8 : 0) });
        truths.push(truth);
        tr.update({ workoutState: i < 2 ? 3 : 10, restTime: 120 });
        tr.update({ splitIntervalTime: truth.t, splitIntervalDistance: 1000, splitIntervalNumber: i + 1 });
        tr.update({ splitIntervalAveragePace: (truth.t * 500) / 1000, splitIntervalNumber: i + 1 });
        if (i < 2) tr.update({ workoutState: 5 });
    }
    assert.equal(tr.pieces.length, 3);
    tr.pieces.forEach((p, i) => checkPiece(p, truths[i], `interval ${i + 1}`));
});

test('intervals 4 × 1:00 time: piece averages match each minute', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 60, workoutDurationType: 0, workoutState: 4 });
    const truths = [];
    for (let i = 0; i < 4; i++) {
        const truth = rowPiece(tr, { kind: 'time', total: 60, state: 4, paceAt: () => 95 + i });
        truths.push(truth);
        tr.update({ workoutState: i < 3 ? 3 : 10, restTime: 60 });
        tr.update({ splitIntervalTime: 60, splitIntervalDistance: truth.d, splitIntervalNumber: i + 1 });
        tr.update({ splitIntervalAveragePace: (60 * 500) / truth.d, splitIntervalNumber: i + 1 });
        if (i < 3) tr.update({ workoutState: 4 });
    }
    tr.pieces.forEach((p, i) => checkPiece(p, truths[i], `minute ${i + 1}`));
});

test('just row: average over whole 500m rows', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 0, workoutDurationType: 0x80, workoutState: 1 });
    rowPiece(tr, { kind: 'distance', total: 2000, paceAt: varying });
    const p = tr.current;
    assert.equal(p.chunk.total, 0);
    assert.ok(p.splits.length >= 3);
    const t = p.splits.reduce((a, s) => a + s.pace, 0);   // equal 500m rows: mean is right here
    near(S.average(p), t / p.splits.length, 0.01, 'just row');
});
