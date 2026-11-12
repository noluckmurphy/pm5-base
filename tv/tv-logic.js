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
        const tenths = Math.round(secs * 10);
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

    // Middle of a band, used as the pace-boat speed.
    bandMid(fast, slow) {
        return (fast + slow) / 2;
    },

    // Session presets from Kyle's current plan (rowing/current-plan.md).
    // Paces are sec/500m. Edit freely; the settings dialog can override
    // any of them for the current session.
    PRESETS: {
        threshold: { label: 'Threshold',   fast: 115.5, slow: 116.5, rateLo: 24, rateHi: 26 },
        max:       { label: 'Max / race pace', fast: 105.5, slow: 106.5, rateLo: 28, rateHi: 29 },
        test:      { label: '2k test (open 1:48)', fast: 107.5, slow: 108.5, rateLo: 28, rateHi: 29 },
        zone2:     { label: 'Zone 2',      fast: 128,   slow: 135,   rateLo: 18, rateHi: 20 },
        free:      { label: 'Just row',    fast: NaN,   slow: NaN,   rateLo: NaN, rateHi: NaN },
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
