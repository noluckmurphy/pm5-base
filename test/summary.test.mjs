// End-of-workout session file (tv/summary.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { summaryLogic: SM } = req('../tv/summary.js');
const { splitsLogic: S, SplitTracker } = req('../tv/splits.js');

function row(tr, pace, total, { hr = 160, rate = 25 } = {}) {
    for (let t = 0.5; ; t += 0.5) {
        const d = (t * 500) / pace;
        tr.update({ elapsedTime: t, distance: d, strokeRate: rate, heartRate: hr });
        if (d >= total) break;
    }
}

function twoByTwoK() {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 2000, workoutDurationType: 0x80, workoutState: 5 });
    row(tr, 115.6, 2000);
    tr.update({ workoutState: 3, restTime: 300 });
    tr.update({ splitIntervalTime: 462.6, splitIntervalDistance: 2000, splitIntervalAveragePace: 115.6, splitIntervalNumber: 1 });
    tr.update({ workoutState: 5 });
    row(tr, 114.9, 2000, { hr: 165 });
    tr.update({ workoutState: 10 });
    tr.update({ splitIntervalTime: 459.7, splitIntervalDistance: 2000, splitIntervalAveragePace: 114.9, splitIntervalNumber: 2 });
    return tr;
}

const target = { label: 'Threshold 2×2000m / 5:00r', preset: 'threshold', fast: 115.5, slow: 116.5, rateLo: 24, rateHi: 26, shift: 0, fromPlan: true };

test('a 2×2000m session becomes a version-1 session file with the PM5 interval figures', () => {
    const s = SM.build(twoByTwoK(), target, { startedAt: '2026-11-14T18:24:00.000Z', endedAt: '2026-11-14T18:52:00.000Z', planSource: 'live', date: '2026-11-14', appVersion: '1.0.7' });
    assert.equal(s.version, 1);
    assert.equal(s.strokes, null);
    assert.equal(s.pieces.length, 2);
    assert.deepEqual(s.program, { kind: 'distance', total: 2000, rest: 300 });
    const [a, b] = s.pieces;
    assert.equal(a.splits.length, 8);
    assert.equal(a.time, 462.6);
    assert.equal(a.distance, 2000);
    assert.equal(a.avgPace, 115.6);
    assert.equal(b.avgPace, 114.9);
    assert.equal(b.hr, 165);
    assert.equal(s.totals.distance, 4000);
    assert.equal(s.totals.spread, 0.7);
    assert.equal(s.plan.source, 'live');
    assert.equal(s.plan.fast, 115.5);
    assert.equal(s.plan.boat, null);
    JSON.parse(JSON.stringify(s));   // plain JSON, no NaN surprises
});

test('without PM5 interval figures the piece time adds up from the splits', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 5 });
    row(tr, 106, 500);
    tr.update({ workoutState: 3 });
    const p = SM.piece(tr.pieces[0], 1);
    assert.equal(p.pm5, null);
    assert.equal(p.distance, 500);
    assert.ok(Math.abs(p.time - 106) < 0.2, String(p.time));
    assert.ok(Math.abs(p.avgPace - 106) < 0.1);
});

test('file names say when and what', () => {
    const s = SM.build(twoByTwoK(), target, { startedAt: new Date(2026, 10, 14, 12, 24).toISOString() });
    assert.equal(SM.fileName(s), '2026-11-14-1224-threshold-2x2000m.json');
});

test('RPE: saved at the top level, null when skipped or out of range, set by arrows and number keys', () => {
    const tr = twoByTwoK();
    assert.equal(SM.build(tr, target, { rpe: 7 }).rpe, 7);
    assert.equal(SM.build(tr, target, {}).rpe, null);
    assert.equal(SM.build(tr, target, { rpe: 11 }).rpe, null);
    assert.equal(SM.build(tr, target, { rpe: 6.5 }).rpe, null);
    assert.equal(SM.stepRpe(null, 1), 5);
    assert.equal(SM.stepRpe(null, -1), 5);
    assert.equal(SM.stepRpe(5, 1), 6);
    assert.equal(SM.stepRpe(10, 1), 10);
    assert.equal(SM.stepRpe(1, -1), 1);
    assert.equal(SM.rpeFromKey('7'), 7);
    assert.equal(SM.rpeFromKey('0'), 10);
    assert.equal(SM.rpeFromKey('a'), null);
});
