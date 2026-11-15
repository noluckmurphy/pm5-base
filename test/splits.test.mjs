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
    assert.equal(p.splits.length, 7);           // the last chunk closes when the piece ends
    S.closeFinal(p);
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
    S.closeFinal(p);
    assert.equal(p.splits.length, 5);
    close(p.splits[0].pace, 110);
    close(p.splits[4].pace, 100);
});

test('time pieces split by time', () => {
    const p = S.newPiece(S.chunkFor(60, 0x00));
    for (const s of steady({ pace: 106, to: 60.5 })) S.addSample(p, s);
    S.closeFinal(p);
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
    tr.update({ workoutState: 3 });                         // rest closes the last split
    assert.equal(first.splits.length, 5);
    assert.equal(tr.current, null);
    tr.update({ elapsedTime: 30, distance: 0 });            // ignored while resting
    tr.update({ workoutState: 5 });                         // back to work
    for (const s of steady({ pace: 105, to: 50 })) tr.update(s);
    assert.ok(tr.current && tr.current !== first);
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

test('easing off after the finish does not spike the last split', () => {
    // Kyle's 2nd 2000m: steady 1:55, then after 2000m the clock keeps running
    // while the flywheel spins down (distance creeps, then stops).
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 2000, workoutDurationType: 0x80, workoutState: 5 });
    for (const s of steady({ pace: 115, to: 460 })) tr.update(s);
    const p = tr.current;
    for (let i = 1; i <= 8; i++) tr.update({ elapsedTime: 460 + i, distance: 2000 + i * 0.6 }); // overshoot, very slow
    for (let i = 9; i <= 12; i++) tr.update({ elapsedTime: 460 + i, distance: 2004.8 });       // stopped
    close(S.currentPace(p), 115, 0.2);                      // live split unaffected
    tr.update({ workoutState: 3 });                         // rest
    assert.equal(p.splits.length, 8);
    close(p.splits[7].pace, 115, 0.2);
    assert.equal(p.splits[7].source, 'estimate');
    // the PM5's own interval figure then replaces the estimate
    tr.update({ splitIntervalTime: 460.2, splitIntervalDistance: 2000 });
    assert.equal(p.splits.length, 8);
    assert.equal(p.splits[7].source, 'pm5');
    close(p.splits[7].pace, (460.2 - 7 * 250 * 115 / 500) * 2, 0.05);
});

test('the PM5 interval figure closes the piece if it arrives before rest', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 5 });
    for (const s of steady({ pace: 106, to: 105.5 })) tr.update(s);
    const p = tr.current;
    tr.update({ splitIntervalTime: 106, splitIntervalDistance: 500 });
    assert.equal(p.splits.length, 5);
    assert.equal(p.splits[4].source, 'pm5');
    close(p.splits[4].pace, 106);
    tr.update({ workoutState: 3 });
    assert.equal(tr.pieces.length, 1);
});

test('no phantom pieces after the workout ends', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 5 });
    for (const s of steady({ pace: 106, to: 106.5 })) tr.update(s);
    tr.update({ workoutState: 10 });                        // workout end
    for (const s of steady({ pace: 300, to: 20 })) tr.update(s);   // paddling after
    tr.update({ workoutState: 12 });
    for (const s of steady({ pace: 300, to: 20 })) tr.update(s);
    assert.equal(tr.pieces.length, 1);
    assert.ok(tr.finished);
});

test('a different programme on the PM5 starts a fresh session', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 0, workoutDurationType: 0x00, workoutState: 1 });  // just row warm-up
    for (const s of steady({ pace: 140, to: 300 })) tr.update(s);
    assert.ok(tr.pieces.length >= 1);
    tr.update({ workoutDuration: 2000, workoutDurationType: 0x80 });
    assert.equal(tr.pieces.length, 0);
    for (const s of steady({ pace: 116, to: 30 })) tr.update(s);
    assert.equal(tr.current.chunk.size, 250);
});

test('vs last only compares pieces of the same shape', () => {
    const tr = new SplitTracker();
    const a = S.newPiece(S.chunkFor(2000, 0x80)); a.splits = [{ n: 1, pace: 116 }];
    const b = S.newPiece(S.chunkFor(500, 0x80));  b.splits = [{ n: 1, pace: 100 }];
    const c = S.newPiece(S.chunkFor(2000, 0x80));
    tr.pieces = [a, b, c]; tr.current = c;
    assert.equal(tr.previousFor(c), a);
    assert.equal(tr.previous, a);
});

test('the programmed rest is read from the rest countdown', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 500, workoutDurationType: 0x80, workoutState: 5 });
    for (const s of steady({ pace: 106, to: 106.5 })) tr.update(s);
    for (let r = 239; r > 200; r--) tr.update({ workoutState: 3, restTime: r });
    tr.update({ workoutState: 5 });
    assert.equal(tr.restSeconds, 240);
});

test('a single timed piece (10:00, 1:00 splits) closes its last minute when the PM5 stops on the clock', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 600, workoutDurationType: 0, workoutState: 1 });
    for (let t = 0.5; t <= 599.8; t += 0.5) tr.update({ elapsedTime: t, distance: (t * 500) / 133, strokeRate: 22 });
    tr.update({ workoutState: 10 });
    const [p] = tr.pieces;
    assert.equal(p.splits.length, 10);
    assert.equal(p.splits[9].mark, 600);
    assert.ok(Math.abs(p.splits[9].pace - 133) < 0.5);
});

test('a single timed piece switches to the PM5 split length at its first split report', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 600, workoutDurationType: 0, workoutState: 1 });
    let t = 0;
    for (; t <= 120; t += 0.5) tr.update({ elapsedTime: t, distance: (t * 500) / 130, strokeRate: 22, heartRate: 130 });
    assert.equal(tr.current.chunk.size, 60);          // guessed from 10:00
    assert.equal(tr.current.splits.length, 2);
    tr.update({ splitIntervalTime: 120, splitIntervalDistance: 461.5, splitIntervalNumber: 1 });
    assert.equal(tr.current.chunk.size, 120);         // PM5 is set to 2:00 splits
    assert.equal(tr.current.splits.length, 1);
    assert.equal(tr.current.splits[0].rate, 22);
    assert.equal(tr.current.splits[0].hr, 130);
    for (; t <= 599.8; t += 0.5) tr.update({ elapsedTime: t, distance: (t * 500) / 130 });
    tr.update({ splitIntervalTime: 120, splitIntervalDistance: 461.5, splitIntervalNumber: 2 });
    assert.equal(tr.current.chunk.size, 120);
    tr.update({ workoutState: 10 });
    assert.equal(tr.pieces.length, 1);
    assert.equal(tr.pieces[0].splits.length, 5);
    assert.equal(tr.pieces[0].splits[4].mark, 600);
});

test('interval pieces are not re-cut by their own end-of-interval report', () => {
    const tr = new SplitTracker();
    tr.update({ workoutDuration: 2000, workoutDurationType: 0x80, workoutState: 5 });
    for (let t = 0.5; ; t += 0.5) { const d = (t * 500) / 116; tr.update({ elapsedTime: t, distance: d }); if (d >= 2000) break; }
    tr.update({ splitIntervalTime: 464, splitIntervalDistance: 2000, splitIntervalNumber: 1 });
    assert.equal(tr.pieces[0].chunk.size, 250);
    assert.equal(tr.pieces[0].splits.length, 8);
});
