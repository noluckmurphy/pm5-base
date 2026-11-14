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
        const { kind, size, total } = piece.chunk;
        const key = kind === 'distance' ? 'd' : 't';
        const end = total > 0 ? piece.origin[key] + total : Infinity;

        // Past the end of the piece (easing off after the finish, or a late
        // sample): keep it aside, it's only used if the PM5 never reports
        // the interval's own time. Never let it into the live split.
        if (cur[key] >= end) {
            // only the first sample past the line is close enough to use
            if (!piece.overshoot) piece.overshoot = cur;
            return piece;
        }
        // Clock ticking with no meters added (stopped, or between strokes):
        // don't let it drag the live split.
        if (kind === 'distance' && cur.d === prev.d && piece.last) return piece;

        // Close every boundary crossed between prev and cur.
        let next = piece.origin[key] + (piece.splits.length + 1) * size;
        while (cur[key] >= next && next < end) {
            const at = splitsLogic._interp(prev, cur, key, next);
            splitsLogic._push(piece, at, next - piece.origin[key]);
            next += size;
        }
        piece.last = cur;
        return piece;
    },

    _push(piece, at, mark, source = 'live') {
        const dt = at.t - piece.start.t;
        const dd = at.d - piece.start.d;
        piece.splits.push({
            n: piece.splits.length + 1,
            mark,
            pace: dd > 0 ? (dt * 500) / dd : NaN,
            rate: piece.acc.nr ? Math.round(piece.acc.rate / piece.acc.nr) : undefined,
            hr: piece.acc.nh ? Math.round(piece.acc.hr / piece.acc.nh) : undefined,
            source,
        });
        piece.start = at;
        piece.acc = { rate: 0, hr: 0, nr: 0, nh: 0 };
    },

    // Close the last chunk of a piece when it ends. `pm5` is the PM5's own
    // figure for the whole interval ({ time, distance }, measured from the
    // piece start) and wins when given. Otherwise use a late sample that
    // overshot the end, or extrapolate the open chunk's pace.
    closeFinal(piece, pm5 = null) {
        if (!piece?.origin || piece.final) return piece;
        const { kind, size, total } = piece.chunk;
        if (!(total > 0)) { piece.final = 'none'; return piece; }
        const rows = splitsLogic.rowCount(piece);
        // Every boundary before the end must already be closed; only the last chunk is open.
        if (piece.splits.length !== rows - 1) { piece.final = 'none'; return piece; }
        let at = null, source = 'estimate';
        if (pm5 && pm5.time > 0) {
            at = { t: piece.origin.t + pm5.time, d: piece.origin.d + (pm5.distance > 0 ? pm5.distance : (kind === 'distance' ? total : 0)) };
            if (kind === 'time') at.t = piece.origin.t + total;
            source = 'pm5';
        } else if (piece.overshoot && piece.last) {
            const key = kind === 'distance' ? 'd' : 't';
            at = splitsLogic._interp(piece.last, piece.overshoot, key, piece.origin[key] + total);
        } else if (piece.last) {
            const pace = splitsLogic.currentPace(piece);
            if (kind === 'distance' && Number.isFinite(pace)) {
                const left = piece.origin.d + total - piece.last.d;
                if (left <= size) at = { t: piece.last.t + (left * pace) / 500, d: piece.origin.d + total };
            }
        }
        if (!at) { piece.final = 'none'; return piece; }
        piece._startBeforeFinal = { ...piece.start };
        splitsLogic._push(piece, at, total, source);
        piece.final = source;
        return piece;
    },

    // Replace an estimated last chunk with the PM5's own interval time.
    reviseFinal(piece, pm5) {
        if (!piece || piece.final !== 'estimate') return piece;
        const last = piece.splits.pop();
        piece.start = piece._startBeforeFinal ?? piece.start;
        piece.final = null;
        // keep the rate/HR the estimated split already had
        piece.acc = { rate: last.rate || 0, hr: last.hr || 0, nr: last.rate ? 1 : 0, nh: last.hr ? 1 : 0 };
        return splitsLogic.closeFinal(piece, pm5);
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

// Tracks pieces across a whole workout. A piece starts when the PM5 is in
// a work state and its per-interval counters start again (after a rest, or
// a reset). The PM5's own interval figures close each piece's last chunk.
const WORK_STATES = [1, 4, 5];          // workout row, interval work time/distance
const DONE_STATES = [10, 11, 12];       // workout end, terminate, logged

class SplitTracker {
    constructor() { this.reset(); }

    reset() {
        this.pieces = [];
        this.current = null;
        this.state = undefined;         // last PM5 workoutState
        this.finished = false;
        this.program = {};              // workoutType / duration as last reported
        this.restSeconds = undefined;   // programmed rest, from the first rest countdown
        this._restMax = 0;
    }

    get working() {
        return this.state === undefined || WORK_STATES.includes(this.state);
    }

    // The latest finished piece of the same shape as `piece` (same chunking
    // and length), for the "vs last" column.
    previousFor(piece) {
        if (!piece) return null;
        for (let i = this.pieces.indexOf(piece) - 1; i >= 0; i--) {
            const p = this.pieces[i];
            if (p.splits.length && p.chunk.kind === piece.chunk.kind
                && p.chunk.size === piece.chunk.size && p.chunk.total === piece.chunk.total) return p;
        }
        return null;
    }

    get previous() { return this.previousFor(this.current ?? this.pieces[this.pieces.length - 1]); }

    _endPiece(pm5 = null) {
        const p = this.current;
        if (!p) return;
        splitsLogic.closeFinal(p, pm5);
        p.done = true;
        if (!p.splits.length) this.pieces.splice(this.pieces.indexOf(p), 1); // never show empty pieces
        this.current = null;
    }

    update(data) {
        // A different workout programmed on the PM5 starts a fresh session.
        const prog = ['workoutType', 'workoutDuration', 'workoutDurationType'];
        for (const k of prog) {
            if (data[k] === undefined) continue;
            if (this.program[k] !== undefined && this.program[k] !== data[k] && this.pieces.some(p => p.splits.length)) {
                this.reset();
            }
            this.program[k] = data[k];
        }

        // The PM5's own end-of-interval figures: close (or correct) the last chunk.
        if (data.splitIntervalTime > 0 && data.splitIntervalDistance > 0) {
            const target = this.current ?? [...this.pieces].reverse().find(p => p.done);
            const total = target?.chunk?.total;
            const matches = total > 0 && (target.chunk.kind === 'distance'
                ? Math.abs(data.splitIntervalDistance - total) <= 5
                : Math.abs(data.splitIntervalTime - total) <= 2);
            if (matches) {
                const pm5 = { time: data.splitIntervalTime, distance: data.splitIntervalDistance };
                if (target === this.current) this._endPiece(pm5);
                else splitsLogic.reviseFinal(target, pm5);
            }
        }
        if (data.splitIntervalAveragePace > 0 && data.splitIntervalNumber !== undefined) {
            const last = [...this.pieces].reverse().find(p => p.done) ?? this.current;
            if (last) last.pm5Avg = data.splitIntervalAveragePace;
        }

        if (data.workoutState !== undefined) {
            const was = this.state;
            this.state = data.workoutState;
            const nowWorking = WORK_STATES.includes(this.state);
            if (was !== undefined && WORK_STATES.includes(was) && !nowWorking) this._endPiece();
            if (DONE_STATES.includes(this.state)) this.finished = true;
            if (this.state === 0 && this.finished) this.reset(), (this.state = 0);
            if (nowWorking) this._restMax = 0;
        }
        // The rest countdown starts at the programmed rest, so its highest
        // value (rounded to 5s) is what the PM5 is set to.
        if (data.restTime > 0 && !this.working) {
            this._restMax = Math.max(this._restMax, data.restTime);
            this.restSeconds = Math.round(this._restMax / 5) * 5;
        }

        if (this.finished || !this.working) return;

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
            this._endPiece(); // counters went back: new interval
        }
        if (!this.current) {
            const chunk = splitsLogic.chunkFor(this.program.workoutDuration, this.program.workoutDurationType);
            this.current = splitsLogic.newPiece(chunk);
            this.pieces.push(this.current);
        } else if (this.current.splits.length === 0 && this.program.workoutDurationType !== undefined) {
            // duration info may arrive just after the first samples
            this.current.chunk = splitsLogic.chunkFor(this.program.workoutDuration, this.program.workoutDurationType);
        }
        splitsLogic.addSample(this.current, data);
    }
}

if (typeof module !== 'undefined') {
    module.exports = { splitsLogic, SplitTracker, WORK_STATES, DONE_STATES };
}
