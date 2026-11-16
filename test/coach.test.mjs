// Rest coaching cards (tv/coach.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { coachLogic: C } = req('../tv/coach.js');
const { tvLogic } = req('../tv/tv-logic.js');
const fmt = tvLogic.formatPace;

const piece = (paces, extra = {}) => ({ splits: paces.map((p, i) => ({ n: i + 1, pace: p, rate: 25 + (i > 5 ? 1 : 0), hr: 150 + i * 2 })), ...extra });
const target = { preset: 'threshold', fast: 115.5, slow: 116.5, rateLo: 24, rateHi: 26 };

test('shape tells a fade from a negative split', () => {
    assert.equal(C.shape(piece([116, 116, 116, 116, 117, 117.5, 118, 118])).kind, 'fade');
    assert.equal(C.shape(piece([118, 116.4, 116, 115.8, 116.2, 116.6, 116.9, 115.1])).kind, 'even');
    assert.equal(C.shape(piece([117, 117, 117, 117, 115, 115, 115, 115])).kind, 'negative');
    assert.equal(C.shape(piece([116])), null);
});

test('cards review the last piece, cue the next one and add notes', () => {
    const cards = C.cards({ piece: piece([118, 116.4, 116, 115.8, 116.2, 116.6, 116.9, 115.1], { pm5Avg: 115.6 }), target, notes: ['Hold 1:56 from stroke one'], fmt });
    assert.deepEqual(cards.map(c => c.title), ['Last piece', 'Next piece', 'Coach notes']);
    assert.match(cards[0].lines[0], /Average 1:55.6, on target/);
    assert.match(cards[1].lines[1], /You opened at 1:58.0/);
    assert.deepEqual(cards[2].lines, ['Hold 1:56 from stroke one']);
});

test('without plan notes the preset cues are used', () => {
    const cards = C.cards({ piece: null, target: { preset: 'zone2', fast: 128, slow: 135 }, notes: [], fmt });
    assert.deepEqual(cards.map(c => c.title), ['Next piece', 'Cues']);
    assert.equal(cards[1].lines[0], C.DEFAULT_NOTES.zone2[0]);
});

test('cards only show in long rests and get out of the way near the end', () => {
    assert.equal(C.visible({ resting: true, restSeconds: 300, restLeft: 250 }), true);
    assert.equal(C.visible({ resting: true, restSeconds: 300, restLeft: 15 }), false);
    assert.equal(C.visible({ resting: true, restSeconds: 60, restLeft: 50 }), true);   // 1:00 rests get cards too
    assert.equal(C.visible({ resting: true, restSeconds: 45, restLeft: 40 }), false);
    assert.equal(C.visible({ resting: false, restSeconds: 300, restLeft: 250 }), false);
    assert.equal(C.visible({ resting: true, restSeconds: 300, restLeft: 250, dismissed: true }), false);
});
