// Pure, DOM-free logic for the TV display (tv/): pace parsing/formatting,
// target-band comparison, heart-rate zones, the pace-boat gap, and the
// session presets. Kept separate from tv/app.js so it can be pinned by
// test/tv-logic.test.mjs under node.

const tvLogic = {

    // "1:55.5" / "1:55" / "115.5" -> seconds per 500m. Returns NaN on junk.
    parsePace(text) {
        const s = String(text ?? '').trim();
        if (!s) return NaN;
        const m = s.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
        if (m) return Number(m[1]) * 60 + Number(m[2]);
        return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    },

    // 115.46 -> "1:55.5". Tenths, like the PM5's own split display.
    formatPace(secs) {
        if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) return '-:--.-';
        // Truncate like the PM5 does (2:02.25 shows as 2:02.2), so averages match it.
        const tenths = Math.floor(secs * 10 + 1e-6);
        const m = Math.floor(tenths / 600);
        const s = (tenths % 600) / 10;
        return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    },

    // 754.2 -> "12:34". Hours if needed.
    formatClock(secs) {
        if (!Number.isFinite(secs) || secs < 0) return '--:--';
        const t = Math.floor(secs);
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = String(t % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    },

    // Compare a pace (sec/500m) with a target band. `fast`/`slow` are the
    // band's edges in sec/500m, so fast < slow. Lower pace = faster boat.
    // Returns { status: 'fast' | 'on' | 'slow' | 'none', delta } where delta
    // is seconds off the nearest band edge (negative = faster than band).
    paceStatus(pace, fast, slow) {
        if (!Number.isFinite(pace) || pace <= 0 || !Number.isFinite(fast) || !Number.isFinite(slow)) {
            return { status: 'none', delta: 0 };
        }
        const [lo, hi] = fast <= slow ? [fast, slow] : [slow, fast];
        if (pace < lo) return { status: 'fast', delta: pace - lo };
        if (pace > hi) return { status: 'slow', delta: pace - hi };
        return { status: 'on', delta: 0 };
    },

    // Same idea for stroke rate, where higher = faster.
    rateStatus(rate, lo, hi) {
        if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(lo) || !Number.isFinite(hi)) return 'none';
        if (rate < lo) return 'low';
        if (rate > hi) return 'high';
        return 'on';
    },

    // `bounds` = ascending lower edges of zones 2..5, e.g. [125, 139, 153, 166].
    // Below bounds[0] is zone 1. Returns 0 when there's no reading (no belt
    // reports 255 over BLE and 0 over USB).
    hrZone(hr, bounds) {
        if (!Number.isFinite(hr) || hr <= 0 || hr >= 255) return 0;
        let zone = 1;
        for (const b of bounds) if (hr >= b) zone++;
        return zone;
    },

    // Metres ahead (+) or behind (-) of a boat holding `targetPace` from the
    // start of the current piece. The PM5 resets elapsed time and distance at
    // the start of every interval, so this is per piece.
    boatGap(distance, elapsed, targetPace) {
        if (!Number.isFinite(distance) || !Number.isFinite(elapsed) || elapsed <= 0) return null;
        if (!Number.isFinite(targetPace) || targetPace <= 0) return null;
        return distance - (elapsed * 500) / targetPace;
    },

    // PM5 workoutState values (see pm5printables.workoutState).
    isRest(workoutState) {
        return [3, 6, 7].includes(workoutState);
    },
    isFinished(workoutState) {
        return [10, 11, 12].includes(workoutState);
    },

    // What's left in the current piece, from general-status. Duration type
    // 0x00 = time (already converted to seconds by pm5-ble.js), 0x80 =
    // distance in metres. Returns null when it can't be worked out (just
    // row, calories, watts, or values that don't add up).
    remaining({ workoutDuration, workoutDurationType, elapsedTime, distance } = {}) {
        if (!Number.isFinite(workoutDuration) || workoutDuration <= 0) return null;
        if (workoutDurationType === 0x00 && Number.isFinite(elapsedTime)) {
            const left = workoutDuration - elapsedTime;
            return left >= 0 && left <= workoutDuration ? { kind: 'time', value: left } : null;
        }
        if (workoutDurationType === 0x80 && Number.isFinite(distance)) {
            const left = workoutDuration - distance;
            return left >= 0 && left <= workoutDuration ? { kind: 'distance', value: left } : null;
        }
        return null;
    },

    // Compare today's planned piece ({ kind, total, rest }, from today.json)
    // with what is programmed on the PM5 (`chunk` from splits.js, and the
    // rest in seconds once the PM5 has shown one). Returns a list of
    // human-readable differences; empty when they agree or can't be told.
    planMismatch(planned, chunk, restSeconds) {
        const out = [];
        if (!planned || !chunk) return out;
        const fmt = (kind, v) => kind === 'time' ? tvLogic.formatClock(v) : `${v}m`;
        if (planned.total > 0) {
            if (!(chunk.total > 0)) out.push(`plan ${fmt(planned.kind, planned.total)}, PM5 just row`);
            else if (planned.kind !== chunk.kind || Math.abs(planned.total - chunk.total) > (chunk.kind === 'time' ? 2 : 5)) {
                out.push(`plan ${fmt(planned.kind, planned.total)}, PM5 ${fmt(chunk.kind, chunk.total)}`);
            }
        }
        if (planned.rest > 0 && restSeconds > 0 && Math.abs(planned.rest - restSeconds) > 5) {
            out.push(`plan ${tvLogic.formatClock(planned.rest)} rest, PM5 ${tvLogic.formatClock(restSeconds)}`);
        }
        return out;
    },

    // Middle of a band, used as the pace-boat speed.
    bandMid(fast, slow) {
        return (fast + slow) / 2;
    },

    // ---------- the TV's own pace boat (#29) ----------
    // The PM5 doesn't send its pace boat setting over Bluetooth, so the TV
    // keeps its own. In a plan mode the boat sits inside the band (middle by
    // default, nudged 0.5s with the remote) and the band still colours the
    // splits. In PM5-only mode the boat is the target: off until set, then a
    // band of BOAT_BAND either side of it.
    BOAT_STEP: 0.5,
    BOAT_BAND: 1,
    BOAT_START: 130,              // first PM5-only boat: 2:10.0
    BOAT_MIN: 85, BOAT_MAX: 180,  // 1:25.0 to 3:00.0; stepping past 3:00 turns a PM5-only boat off

    // Boat pace (sec/500m) for a band, or null. `boat` is the set value
    // (null = middle of the band); it's kept inside the band.
    boatInBand(fast, slow, boat) {
        if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;
        const [lo, hi] = fast <= slow ? [fast, slow] : [slow, fast];
        if (!Number.isFinite(boat)) return (lo + hi) / 2;
        return Math.min(hi, Math.max(lo, boat));
    },

    // Next boat value after one remote step (dir -1 = faster, +1 = slower).
    // With a band the boat stays inside it; without one (PM5-only) it starts
    // at BOAT_START and turns off (null) past BOAT_MAX.
    stepBoat(boat, dir, band = null) {
        const step = tvLogic.BOAT_STEP * Math.sign(dir);
        if (band) {
            const cur = tvLogic.boatInBand(band.fast, band.slow, boat);
            return cur === null ? null : tvLogic.boatInBand(band.fast, band.slow, Math.round((cur + step) * 2) / 2);
        }
        if (!Number.isFinite(boat)) return dir < 0 ? tvLogic.BOAT_START : null;
        const next = Math.round((boat + step) * 2) / 2;
        if (next > tvLogic.BOAT_MAX) return null;
        return Math.max(tvLogic.BOAT_MIN, next);
    },

    // Band around a PM5-only boat.
    boatBand(boat) {
        return Number.isFinite(boat) ? { fast: boat - tvLogic.BOAT_BAND, slow: boat + tvLogic.BOAT_BAND } : null;
    },

    // Where the rower's dot sits on the race strip: 0..1, boat at 0.5,
    // `scale` metres either side reaching the ends.
    stripPos(gap, scale = 25) {
        if (!Number.isFinite(gap)) return 0.5;
        return Math.min(1, Math.max(0, 0.5 + gap / (2 * scale)));
    },

    // Short gap text under the strip.
    boatGapText(gap, boat) {
        if (!Number.isFinite(gap) || !Number.isFinite(boat)) return '';
        const m = Math.round(gap);
        const b = tvLogic.formatPace(boat);
        return m === 0 ? `Level with ${b} boat` : `${m > 0 ? '+' : '−'}${Math.abs(m)}m vs ${b} boat`;
    },

    // Session presets from Kyle's current plan (rowing/current-plan.md).
    // Paces are sec/500m. Edit freely; the settings dialog can override
    // any of them for the current session.
    PRESETS: {
        threshold: { label: 'Threshold',   fast: 115.5, slow: 116.5, rateLo: 24, rateHi: 26 },
        max:       { label: 'Max / race pace', fast: 105.5, slow: 106.5, rateLo: 28, rateHi: 29 },
        test:      { label: '2k test (open 1:48)', fast: 107.5, slow: 108.5, rateLo: 28, rateHi: 29 },
        zone2:     { label: 'Zone 2',      fast: 128,   slow: 135,   rateLo: 18, rateHi: 20 },
        free:      { label: 'PM5 only',    fast: NaN,   slow: NaN,   rateLo: NaN, rateHi: NaN },
    },

    // Lower edges of HR zones 2..5. Zone 2 = 125-138 matches the plan's
    // provisional band; the rest are placeholders until test-day max HR.
    DEFAULT_HR_BOUNDS: [125, 139, 153, 166],
};

// ponytail: export shim so test/tv-logic.test.mjs can import under node; a
// no-op in the browser (no `module`).
if (typeof module !== 'undefined') {
    module.exports = { tvLogic };
}
