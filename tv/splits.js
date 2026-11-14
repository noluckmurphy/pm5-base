// Live split breakdown for the TV display. Pure and DOM-free (pinned by
// test/splits.test.mjs): feed it PM5 samples ({ elapsedTime, distance,
// strokeRate, heartRate, workoutState, workoutDuration, workoutDurationType })
// and it cuts each piece into fixed chunks, the way a coach's split sheet
// would, independent of whatever split length is set on the PM5.

const splitsLogic = {

    // How big each chunk is, from what the PM5 says the piece is.
    // Distance pieces: <=500m -> 100m, <=2000m -> 250m, longer -> 500m.
    // Time pieces: <=3min -> 30s, <=10min -> 1min, longer -> 2min.
    // Just-row / unknown -> 500m.
    chunkFor(workoutDuration, workoutDurationType) {
        if (workoutDurationType === 0x80 && workoutDuration > 0) {
            if (workoutDuration <= 500) return { kind: 'distance', size: 100, total: workoutDuration };
            if (workoutDuration <= 2000) return { kind: 'distance', size: 250, total: workoutDuration };
            return { kind: 'distance', size: 500, total: workoutDuration };
        }
        if (workoutDurationType === 0x00 && workoutDuration > 0) {
            if (workoutDuration <= 180) return { kind: 'time', size: 30, total: workoutDuration };
            if (workoutDuration <= 600) return { kind: 'time', size: 60, total: workoutDuration };
            return { kind: 'time', size: 120, total: workoutDuration };
        }
        return { kind: 'distance', size: 500, total: 0 };
    },

    // Linear interpolation of the moment a boundary was crossed.
    _interp(prev, cur, key, value) {
        const span = cur[key] - prev[key];
        if (span <= 0) return { t: cur.t, d: cur.d };
        const f = (value - prev[key]) / span;
        return { t: prev.t + f * (cur.t - prev.t), d: prev.d + f * (cur.d - prev.d) };
    },

    newPiece(chunk) {
        return { chunk, splits: [], origin: null, start: null, last: null, acc: { rate: 0, hr: 0, nr: 0, nh: 0 } };
    },

    // Feed one sample into a piece. Returns the piece (mutated).
    addSample(piece, { elapsedTime: t, distance: d, strokeRate, heartRate }) {
        if (!Number.isFinite(t) || !Number.isFinite(d)) return piece;
        const cur = { t, d };
        if (strokeRate > 0) { piece.acc.rate += strokeRate; piece.acc.nr++; }
        if (heartRate > 0 && heartRate < 255) { piece.acc.hr += heartRate; piece.acc.nh++; }

        if (!piece.origin) {
            // The PM5 normally resets time/distance each interval, so a piece
            // starts at 0. If it doesn't (counters keep running), start from
            // wherever this piece's first sample is.
            piece.origin = (d < 20 && t < 10) ? { t: 0, d: 0 } : { t, d };
            piece.start = { ...piece.origin };
        }
        const prev = piece.last ?? piece.origin;
        if (cur.t < prev.t || cur.d < prev.d) return piece; // out of order; ignore
        const { kind, size } = piece.chunk;
        const key = kind === 'distance' ? 'd' : 't';

        // Close every boundary crossed between prev and cur.
        let next = piece.origin[key] + (piece.splits.length + 1) * size;
        while (cur[key] >= next) {
            const at = splitsLogic._interp(prev, cur, key, next);
            const dt = at.t - piece.start.t;
            const dd = at.d - piece.start.d;
            piece.splits.push({
                n: piece.splits.length + 1,
                mark: next - piece.origin[key],
                pace: dd > 0 ? (dt * 500) / dd : NaN,
                rate: piece.acc.nr ? Math.round(piece.acc.rate / piece.acc.nr) : undefined,
                hr: piece.acc.nh ? Math.round(piece.acc.hr / piece.acc.nh) : undefined,
            });
            piece.start = at;
            piece.acc = { rate: 0, hr: 0, nr: 0, nh: 0 };
            next += size;
        }
        piece.last = cur;
        return piece;
    },

    // Pace of the chunk in progress so far (sec/500m), or NaN.
    currentPace(piece) {
        if (!piece?.last || !piece.start) return NaN;
        const dt = piece.last.t - piece.start.t;
        const dd = piece.last.d - piece.start.d;
        return dd >= 10 ? (dt * 500) / dd : NaN;
    },

    // How far through the chunk in progress (0..1).
    currentProgress(piece) {
        if (!piece?.last || !piece.start) return 0;
        const { kind, size } = piece.chunk;
        const v = kind === 'distance' ? piece.last.d - piece.start.d : piece.last.t - piece.start.t;
        return Math.max(0, Math.min(1, v / size));
    },

    // Number of rows to show: from the piece length if known, else splits so far + 1.
    rowCount(piece) {
        const { size, total } = piece.chunk;
        if (total > 0) return Math.ceil(total / size - 1e-9);
        return piece.splits.length + 1;
    },

    // Seconds faster (-) or slower (+) than the same chunk of an earlier piece.
    vsPrevious(split, prevPiece) {
        const p = prevPiece?.splits?.[split.n - 1];
        if (!p || !Number.isFinite(p.pace) || !Number.isFinite(split.pace)) return null;
        return split.pace - p.pace;
    },

    // Average pace of the finished splits.
    average(piece) {
        const ok = piece.splits.filter(s => Number.isFinite(s.pace));
        if (!ok.length) return NaN;
        // Weighted by each chunk's share: equal chunks, so a plain mean of
        // time-per-500m is right for distance chunks. For time chunks weight
        // by distance covered instead (500 * size / pace).
        if (piece.chunk.kind === 'distance') return ok.reduce((a, s) => a + s.pace, 0) / ok.length;
        const dist = ok.reduce((a, s) => a + (500 * piece.chunk.size) / s.pace, 0);
        return (piece.chunk.size * ok.length * 500) / dist;
    },
};

// Tracks pieces across a whole workout: starts a new piece whenever the PM5
// resets its per-interval distance/time or goes from rest back to work, and
// keeps the previous piece for comparison.
class SplitTracker {
    constructor() { this.reset(); }

    reset() {
        this.pieces = [];
        this.current = null;
        this._resting = false;
        this._duration = { workoutDuration: undefined, workoutDurationType: undefined };
    }

    get previous() {
        const done = this.pieces.filter(p => p !== this.current && p.splits.length);
        return done[done.length - 1] ?? null;
    }

    update(data) {
        if (data.workoutDuration !== undefined) this._duration.workoutDuration = data.workoutDuration;
        if (data.workoutDurationType !== undefined) this._duration.workoutDurationType = data.workoutDurationType;

        if (data.workoutState !== undefined) {
            const resting = [3, 6, 7].includes(data.workoutState);
            if (this._resting && !resting) this.current = null; // rest just ended: next sample starts a new piece
            this._resting = resting;
            if (data.workoutState === 0 && this.current?.splits.length) {
                this.reset(); // waiting to begin a new workout
            }
        }
        if (this._resting) return;

        const hasPos = Number.isFinite(data.elapsedTime) && Number.isFinite(data.distance);
        if (!hasPos) {
            // stroke-only messages still feed rate/HR into the open chunk
            if (this.current && (data.strokeRate > 0 || data.heartRate > 0)) {
                if (data.strokeRate > 0) { this.current.acc.rate += data.strokeRate; this.current.acc.nr++; }
                if (data.heartRate > 0 && data.heartRate < 255) { this.current.acc.hr += data.heartRate; this.current.acc.nh++; }
            }
            return;
        }

        const last = this.current?.last;
        if (this.current && last && (data.distance + 5 < last.d || data.elapsedTime + 2 < last.t)) {
            this.current = null; // counters went back: new interval
        }
        if (!this.current) {
            const chunk = splitsLogic.chunkFor(this._duration.workoutDuration, this._duration.workoutDurationType);
            this.current = splitsLogic.newPiece(chunk);
            this.pieces.push(this.current);
        } else if (this.current.splits.length === 0 && this._duration.workoutDurationType !== undefined) {
            // duration info may arrive just after the first samples
            this.current.chunk = splitsLogic.chunkFor(this._duration.workoutDuration, this._duration.workoutDurationType);
        }
        splitsLogic.addSample(this.current, data);
    }
}

if (typeof module !== 'undefined') {
    module.exports = { splitsLogic, SplitTracker };
}
