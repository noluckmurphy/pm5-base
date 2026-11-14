// End-of-workout session file. Pure and DOM-free (test/summary.test.mjs).
// The TV app saves this JSON to the repo's workout-logs branch so the
// workout log can be filled in without a PM5 photo. Times are wall-clock
// ISO strings from the TV, never the PM5's own clock (it resets).
//
// Format, version 1:
// {
//   version: 1, app: 'erg-tv', appVersion,
//   startedAt, endedAt,                 // ISO, TV clock
//   plan: { date, label, preset, fast, slow, rateLo, rateHi, shift, source },
//   program: { kind: 'distance'|'time'|'just-row', total, rest },
//   pieces: [{
//     n, kind, total, chunk,           // chunk = split length used
//     time, distance, avgPace,         // seconds, metres, sec/500m
//     pm5: { time, distance, avgPace } // the PM5's own interval figures, when sent
//     rate, hr, hrMax,                 // piece averages / max
//     spread,                          // slowest minus fastest split, sec/500m
//     splits: [{ mark, pace, rate, hr, source }],
//   }],
//   totals: { distance, time, avgPace, spread },   // spread across piece averages
//   strokes: null,                     // reserved: [{ t, d, pace, rate, hr, watts }]
// }

const summaryLogic = {

    round(v, dp = 1) {
        return Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null;
    },

    piece(p, n) {
        const { kind, size, total } = p.chunk;
        const splits = p.splits.filter(s => Number.isFinite(s.pace));
        const paces = splits.map(s => s.pace);
        // time and distance of the piece: the PM5's figures win, else add up the splits
        let distance = p.pm5Distance ?? null, time = p.pm5Time ?? null;
        if (time === null || distance === null) {
            let t = 0, d = 0, prevMark = 0;
            for (const s of splits) {
                const len = s.mark - prevMark; prevMark = s.mark;
                if (kind === 'distance') { d += len; t += (s.pace * len) / 500; }
                else { t += len; d += (500 * len) / s.pace; }
            }
            if (time === null) time = t;
            if (distance === null) distance = d;
        }
        const avgPace = p.pm5Avg > 0 ? p.pm5Avg : distance > 0 ? (time * 500) / distance : NaN;
        const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
        const rates = splits.map(s => s.rate).filter(v => v > 0);
        const hrs = splits.map(s => s.hr).filter(v => v > 0);
        const r = summaryLogic.round;
        return {
            n, kind: total > 0 ? kind : 'just-row', total: total || null, chunk: size,
            time: r(time), distance: Math.round(distance), avgPace: r(avgPace),
            pm5: p.pm5Time ? { time: r(p.pm5Time), distance: p.pm5Distance ?? null, avgPace: r(p.pm5Avg) } : null,
            rate: rates.length ? Math.round(mean(rates)) : null,
            hr: hrs.length ? Math.round(mean(hrs)) : null,
            hrMax: hrs.length ? Math.max(...hrs) : null,
            spread: paces.length > 1 ? r(Math.max(...paces) - Math.min(...paces)) : null,
            splits: splits.map(s => ({ mark: s.mark, pace: r(s.pace), rate: s.rate ?? null, hr: s.hr ?? null, source: s.source ?? 'live' })),
        };
    },

    // tracker: SplitTracker; target: app.js target(); extra: { planDay, planSource, appVersion, startedAt, endedAt }
    build(tracker, target, extra = {}) {
        const pieces = tracker.pieces.filter(p => p.splits.length).map((p, i) => summaryLogic.piece(p, i + 1));
        const r = summaryLogic.round;
        const distance = pieces.reduce((a, p) => a + p.distance, 0);
        const time = pieces.reduce((a, p) => a + p.time, 0);
        const avgs = pieces.map(p => p.avgPace).filter(Number.isFinite);
        const first = tracker.pieces[0]?.chunk;
        const num = v => Number.isFinite(v) ? v : null;
        return {
            version: 1,
            app: 'erg-tv',
            appVersion: extra.appVersion ?? null,
            startedAt: extra.startedAt ?? null,
            endedAt: extra.endedAt ?? null,
            plan: {
                date: extra.date ?? null,
                label: target?.label ?? null,
                preset: target?.preset ?? null,
                fast: num(target?.fast), slow: num(target?.slow),
                rateLo: num(target?.rateLo), rateHi: num(target?.rateHi),
                shift: target?.shift ?? 0,
                source: target?.fromPlan ? (extra.planSource ?? 'plan') : 'manual',
            },
            program: {
                kind: first?.total > 0 ? first.kind : 'just-row',
                total: first?.total || null,
                rest: tracker.restSeconds ?? null,
            },
            pieces,
            totals: {
                distance, time: r(time),
                avgPace: distance > 0 ? r((time * 500) / distance) : null,
                spread: avgs.length > 1 ? r(Math.max(...avgs) - Math.min(...avgs)) : null,
            },
            strokes: null,
        };
    },

    // File name for the repo: workouts/2026-11-14-1224-threshold-2x2000m.json
    fileName(summary) {
        const d = new Date(summary.startedAt ?? Date.now());
        const pad = n => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        const n = summary.pieces.length;
        const what = summary.program.kind === 'just-row' ? 'just-row'
            : `${n}x${summary.program.kind === 'time' ? summary.program.total + 's' : summary.program.total + 'm'}`;
        return `${stamp}-${summary.plan.preset ?? 'free'}-${what}.json`;
    },
};

if (typeof module !== 'undefined') {
    module.exports = { summaryLogic };
}
