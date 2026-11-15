// Concept2 workout ideas for PM5-only mode (tv/wods.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { wodLogic: W } = createRequire(import.meta.url)('../tv/wods.js');

test('every workout lands in exactly one length bucket, and each bucket has choices', () => {
    const counts = W.BUCKETS.map(b => W.inBucket(b).length);
    assert.equal(counts.reduce((a, n) => a + n, 0), W.WODS.length);
    for (const n of counts) assert.ok(n >= 3);
    for (const w of W.WODS) {
        assert.ok(w.name && w.pm5 && w.how && /^\d{4}-\d{2}-\d{2}$/.test(w.date));
        assert.ok(w.min > 0 && w.min <= 60);
    }
});
