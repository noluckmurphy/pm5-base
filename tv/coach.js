// Coaching cards for long rests (#10). Pure and DOM-free (test/coach.test.mjs).
// Each card is { title, lines: [string] }; app.js shows them over the
// breakdown during a rest and pages them with the remote.

const coachLogic = {

    // Seconds of rest needed before the cards show up at all, and how long
    // before the rest ends they get out of the way.
    MIN_REST: 60,
    HIDE_BEFORE_END: 20,

    // Generic cues per preset, used when today's plan has no notes.
    DEFAULT_NOTES: {
        threshold: ['Hold the target from stroke one; no sandbagged opener.', 'Long, relaxed drive. Rate stays in the band.', 'Spread under 2s across the piece.'],
        max: ['First 10 strokes sharp, then settle to race pace.', 'Squeeze the last 250m; stay long.', 'Breathe out hard on every drive.'],
        test: ['Open at the target, not faster.', 'Middle 1000m: hold, don\'t chase.', 'Last 500m: lift the rate 2 beats, then go.'],
        zone2: ['Nose-breathing pace. HR under the cap.', 'Rate 18 to 20; long and easy.', 'Quiet catch, smooth recovery.'],
        free: ['Breathe down: in for 4, out for 6.', 'Sip water. Shake out the legs.'],
    },

    _fmt: s => (typeof tvLogic !== 'undefined' ? tvLogic : coachLogic._tv).formatPace(s),
    _tv: null,

    // Did the piece fade, hold or negative-split? Compares the average of the
    // first and second halves of its splits.
    shape(piece) {
        const p = (piece?.splits ?? []).map(s => s.pace).filter(Number.isFinite);
        if (p.length < 2) return null;
        const h = Math.floor(p.length / 2);
        const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
        const first = mean(p.slice(0, h)), second = mean(p.slice(p.length - h));
        const d = second - first;
        return { first, second, delta: d, kind: Math.abs(d) < 0.5 ? 'even' : d < 0 ? 'negative' : 'fade' };
    },

    cards({ piece, target, notes, fmt }) {
        const f = fmt ?? coachLogic._fmt;
        const out = [];
        const hasTarget = Number.isFinite(target?.fast) && Number.isFinite(target?.slow);
        if (piece?.splits?.length) {
            const lines = [];
            const paces = piece.splits.map(s => s.pace).filter(Number.isFinite);
            const avg = piece.pm5Avg > 0 ? piece.pm5Avg : paces.reduce((a, b) => a + b, 0) / paces.length;
            let l = `Average ${f(avg)}`;
            if (hasTarget) {
                const off = avg < target.fast ? avg - target.fast : avg > target.slow ? avg - target.slow : 0;
                l += off === 0 ? ', on target' : `, ${Math.abs(off).toFixed(1)}s ${off < 0 ? 'faster' : 'slower'} than the band`;
            }
            lines.push(l);
            const sh = coachLogic.shape(piece);
            if (sh) lines.push(sh.kind === 'even' ? `Even pacing (halves within ${Math.abs(sh.delta).toFixed(1)}s)`
                : sh.kind === 'negative' ? `Negative split: second half ${Math.abs(sh.delta).toFixed(1)}s faster`
                : `Faded: second half ${sh.delta.toFixed(1)}s slower`);
            if (paces.length > 1) lines.push(`Spread ${(Math.max(...paces) - Math.min(...paces)).toFixed(1)}s, slowest split ${f(Math.max(...paces))}`);
            const rates = piece.splits.map(s => s.rate).filter(v => v > 0);
            if (rates.length > 1) lines.push(`Rate ${rates[0]} → ${rates[rates.length - 1]}`);
            const hrs = piece.splits.map(s => s.hr).filter(v => v > 0);
            if (hrs.length) lines.push(`HR finished at ${hrs[hrs.length - 1]}`);
            out.push({ title: 'Last piece', lines });
        }
        if (hasTarget) {
            const lines = [`Band ${f(target.fast)} to ${f(target.slow)}`];
            const sh = coachLogic.shape(piece);
            const opener = piece?.splits?.[0]?.pace;
            if (Number.isFinite(opener) && opener > target.slow + 0.5) lines.push(`You opened at ${f(opener)}. Start at ${f(target.slow)} from stroke one.`);
            else lines.push(`Open at ${f(target.slow)} from stroke one`);
            if (sh?.kind === 'fade') lines.push('Hold form through the middle; the fade started there last time.');
            if (Number.isFinite(target.rateLo)) lines.push(`Rate ${target.rateLo} to ${target.rateHi}`);
            out.push({ title: 'Next piece', lines });
        }
        const n = (notes && notes.length ? notes : coachLogic.DEFAULT_NOTES[target?.preset] ?? coachLogic.DEFAULT_NOTES.free).slice(0, 4);
        out.push({ title: notes && notes.length ? 'Coach notes' : 'Cues', lines: n });
        return out;
    },

    // Should the cards be up? restLeft is the PM5 rest countdown in seconds.
    visible({ resting, restSeconds, restLeft, dismissed }) {
        if (!resting || dismissed) return false;
        if (!(Math.max(restSeconds ?? 0, restLeft ?? 0) >= coachLogic.MIN_REST)) return false;
        return !(restLeft > 0 && restLeft <= coachLogic.HIDE_BEFORE_END);
    },
};

if (typeof module !== 'undefined') {
    module.exports = { coachLogic };
}
