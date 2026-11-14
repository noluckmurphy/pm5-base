// Pure tests for the TV split breakdown (tv/splits.js).
//   node --test test/splits.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { splitsLogic: S, SplitTracker } = createRequire(import.meta.url)('../tv/splits.js');

const close = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// Steady rowing at `pace` sec/500m, sampled every `dt` seconds.
function* steady({ pace, from = 0, to, dt = 0.5, t0 = 0, d0 = 0, rate = 25, hr = 150 }) {
    for (let t = from; t <= to + 1e-9; t += dt) {
        yield { elapsedTime: t0 + t, distance: d0 + (t * 500) / pace, strokeRate: rate, heartRate: hr };
    }
}

test('chunkFor picks chunk sizes by piece length', () => {
    assert.deepEqual(S.chunkFor(500, 0x80), { kind: 'distance', size: 100, total: 500 });
    assert.deepEqual(S.chunkFor(2000, 0x80), { kind: 'distance', size: 250, total: 2000 });
    assert.deepEqual(S.chunkFor(5000, 0x80), { kind: 'distance', size: 500, total: 5000 });
    assert.deepEqual(S.chunkFor(60, 0x00), { kind: 'time', size: 30, total: 60 });
    assert.deepEqual(S.chunkFor(1800, 0x00), { kind: 'time', size: 120, total: 1800 });
    assert.equal(S.chunkFor(undefined, undefined).size, 500);
});

test('a steady 2000m piece cuts into eight equal 250m splits', () => {
    const p = S.newPiece(S.chunkFor(2000, 0x80));
    for (const s of steady({ pace: 116, to: 464.1 })) S.addSample(p, s);
    assert.equal(p.splits.length, 8);
    for (const sp of p.splits) close(sp.pace, 116);
    assert.equal(p.splits[0].mark, 250);
    assert.equal(p.splits[7].mark, 2000);
    assert.equal(p.splits[0].rate, 25);
    assert.equal(S.rowCount(p), 8);
    close(S.average(p), 116);
});

test('a fast finish shows up in the later splits', () => {
    const p = S.newPiece(S.chunkFor(500, 0x80));
    for (const s of steady({ pace: 110, to: 66 })) S.addSample(p, s);              // 300m
    const t300 = 66, d300 = (66 * 500) / 110;
    for (const s of steady({ pace: 100, from: 0.5, to: 45, t0: t300, d0: d300 })) S.addSample(p, s);
    assert.equal(p.splits.length, 5);
    close(p.splits[0].pace, 110);
    close(p.splits[4].pace, 100);
});

test('time pieces split by time', () => {
    const p = S.newPiece(S.chunkFor(60, 0x00));
    for (const s of steady({ pace: 106, to: 60 })) S.addSample(p, s);
    assert.equal(p.splits.length, 2);
    close(p.splits[0].pace, 106);
    close(S.average(p), 106);
});

test('a piece whose counters do not start at zero is measured from its first sample', () => {
    const p = S.newPiece(S.chunkFor(500, 0x80));
    for (const s of steady({ pace: 120, to: 30, t0: 300, d0: 1200 })) S.addSample(p, s);
    assert.equal(p.splits.length, 1);
    close(p.splits[0].pace, 120);
    assert.equal(p.splits[0].mark, 100);
});

test('currentPace and progress track the open chunk', () => {
    const p = S.newPiece(S.chunkFor(2000, 0x80));
    for (const s of steady({ pace: 120, to: 30 })) S.addSample(p, s);   // 125m
    close(S.currentPace(p), 120);
    close(S.currentProgress(p), 0.5, 0.01);
});

test('vsPrevious compares the same chunk of the previous piece', () => {
    const a = S.newPiece(S.chunkFor(500, 0x80));
    for (const s of steady({ pace: 106, to: 106 })) S.addSample(a, s);
    const b = S.newPiece(S.chunkFor(500, 0x80));
    for (const s of steady({ pace: 105, to: 105 })) S.addSample(b, s);
    close(S.vsPrevious(b.splits[0], a), -1);
    assert.equal(S.vsPrevious(b.splits[0], null), null);
});

test('SplitTracker starts a new piece after rest and keeps the previous one', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 5 });
    for (const s of steady({ pace: 106, to: 106 })) tr.update(s);
    const first = tr.current;
    assert.equal(first.splits.length, 5);
    tr.update({ workoutState: 3 });                         // rest
    tr.update({ elapsedTime: 30, distance: 0 });            // ignored while resting
    tr.update({ workoutState: 5 });                         // back to work
    for (const s of steady({ pace: 105, to: 50 })) tr.update(s);
    assert.notEqual(tr.current, first);
    assert.equal(tr.previous, first);
    assert.equal(tr.pieces.length, 2);
    close(S.vsPrevious(tr.current.splits[0], tr.previous), -1);
});

test('SplitTracker starts a new piece when the PM5 counters reset', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80 });
    for (const s of steady({ pace: 106, to: 106 })) tr.update(s);
    for (const s of steady({ pace: 106, to: 30 })) tr.update(s);
    assert.equal(tr.pieces.length, 2);
});

test('SplitTracker folds stroke-only messages into the open chunk', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80 });
    tr.update({ elapsedTime: 0.5, distance: 2 });
    tr.update({ elapsedTime: 1, strokeRate: 30, heartRate: 160 });
    tr.update({ elapsedTime: 25, distance: 110 });
    assert.equal(tr.current.splits[0].rate, 30);
    assert.equal(tr.current.splits[0].hr, 160);
});
