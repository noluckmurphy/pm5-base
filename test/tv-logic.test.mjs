// Pure tests for the TV display's maths (tv/tv-logic.js). No DOM needed.
//   node --test test/tv-logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { tvLogic: L } = createRequire(import.meta.url)('../tv/tv-logic.js');

test('parsePace reads m:ss.s and plain seconds', () => {
    assert.equal(L.parsePace('1:55.5'), 115.5);
    assert.equal(L.parsePace('2:08'), 128);
    assert.equal(L.parsePace('115.5'), 115.5);
    assert.ok(Number.isNaN(L.parsePace('')));
    assert.ok(Number.isNaN(L.parsePace('fast')));
    assert.ok(Number.isNaN(L.parsePace('1:75')));
});

test('formatPace shows tenths and rounds like the PM5', () => {
    assert.equal(L.formatPace(115.5), '1:55.5');
    assert.equal(L.formatPace(105), '1:45.0');
    assert.equal(L.formatPace(119.96), '2:00.0');
    assert.equal(L.formatPace(0), '-:--.-');
    assert.equal(L.formatPace(undefined), '-:--.-');
});

test('formatClock shows m:ss and h:mm:ss', () => {
    assert.equal(L.formatClock(0), '0:00');
    assert.equal(L.formatClock(754.9), '12:34');
    assert.equal(L.formatClock(3725), '1:02:05');
});

test('paceStatus compares against the band, lower pace = faster', () => {
    assert.deepEqual(L.paceStatus(116, 115.5, 116.5), { status: 'on', delta: 0 });
    assert.equal(L.paceStatus(114.5, 115.5, 116.5).status, 'fast');
    assert.equal(L.paceStatus(114.5, 115.5, 116.5).delta, -1);
    assert.equal(L.paceStatus(118, 115.5, 116.5).status, 'slow');
    assert.equal(L.paceStatus(118, 115.5, 116.5).delta, 1.5);
    assert.equal(L.paceStatus(116, NaN, NaN).status, 'none');
    assert.equal(L.paceStatus(0, 115.5, 116.5).status, 'none');
});

test('rateStatus', () => {
    assert.equal(L.rateStatus(25, 24, 26), 'on');
    assert.equal(L.rateStatus(22, 24, 26), 'low');
    assert.equal(L.rateStatus(30, 24, 26), 'high');
    assert.equal(L.rateStatus(25, NaN, NaN), 'none');
});

test('hrZone uses lower edges and treats 0/255 as no strap', () => {
    const b = [125, 139, 153, 166];
    assert.equal(L.hrZone(110, b), 1);
    assert.equal(L.hrZone(125, b), 2);
    assert.equal(L.hrZone(138, b), 2);
    assert.equal(L.hrZone(139, b), 3);
    assert.equal(L.hrZone(170, b), 5);
    assert.equal(L.hrZone(0, b), 0);
    assert.equal(L.hrZone(255, b), 0);
});

test('boatGap is metres ahead of a boat at target pace', () => {
    // 120 s at 2:00/500m = 500 m. 510 m rowed -> 10 m ahead.
    assert.equal(L.boatGap(510, 120, 120), 10);
    assert.equal(L.boatGap(490, 120, 120), -10);
    assert.equal(L.boatGap(100, 0, 120), null);
    assert.equal(L.boatGap(100, 30, NaN), null);
});

test('rest and finished states', () => {
    assert.ok(L.isRest(3));
    assert.ok(!L.isRest(5));
    assert.ok(L.isFinished(10));
    assert.ok(!L.isFinished(1));
});

test('remaining works for time and distance pieces only', () => {
    assert.deepEqual(L.remaining({ workoutDuration: 2000, workoutDurationType: 0x80, distance: 1500 }),
        { kind: 'distance', value: 500 });
    assert.deepEqual(L.remaining({ workoutDuration: 1800, workoutDurationType: 0x00, elapsedTime: 600 }),
        { kind: 'time', value: 1200 });
    assert.equal(L.remaining({ workoutDuration: 2000, workoutDurationType: 0x80, distance: 2500 }), null);
    assert.equal(L.remaining({ workoutDuration: 0, workoutDurationType: 0x80, distance: 10 }), null);
    assert.equal(L.remaining({ workoutDuration: 300, workoutDurationType: 0x40, distance: 10 }), null);
});

test('presets have a fast edge at or below the slow edge', () => {
    for (const [id, p] of Object.entries(L.PRESETS)) {
        if (Number.isNaN(p.fast)) continue;
        assert.ok(p.fast <= p.slow, id);
        assert.ok(p.rateLo <= p.rateHi, id);
    }
});
