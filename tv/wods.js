// Workout ideas for PM5-only mode, taken from Concept2's RowErg Workout of
// the Day (log.concept2.com/wod, Oct 1 - Nov 15 2026). The workouts are
// Concept2's; the minutes and the PM5 setup lines are ours. Minutes are
// work plus rest at Kyle's current paces (about 2:00/500m for hard pieces),
// so they'll come down as he gets faster. Pure and DOM-free
// (test/wods.test.mjs).

const wodLogic = {

    BUCKETS: [10, 20, 30, 60],

    // date: the Concept2 WOD day it's from; cut: a shortened version of it.
    WODS: [
        { min: 4,  name: '1000m for time', date: '2026-11-12', pm5: 'Single Distance 1000m', how: 'All out. Hold 2:00 for 500m, then go.' },
        { min: 4,  name: 'Tabata: 8 × 20s / 10s', date: '2026-10-15', cut: true, pm5: 'Intervals: Time 0:20 work, 0:10 rest, 8 reps', how: 'One set of the Triple Tabata. Hard on, easy off.' },
        { min: 9,  name: '5 × 1:00 / 1:00 easy', date: '2026-10-13', cut: true, pm5: 'Intervals: Time 1:00 work, 1:00 rest, 5 reps', how: 'Half of the 10 × 1:00. A good warm-up primer.' },
        { min: 8,  name: '3 × 500m / 1:00 easy', date: '2026-10-19', cut: true, pm5: 'Intervals: Distance 500m, 1:00 rest, 3 reps', how: 'Half of the 6 × 500m. Strong, even pieces.' },

        { min: 17, name: '6 × 2:00 / 1:00 easy', date: '2026-11-08', pm5: 'Intervals: Time 2:00 work, 1:00 rest, 6 reps', how: 'Steady-hard. Keep the rate in the mid 20s.' },
        { min: 18, name: '5 × 500m / 2:00 easy', date: '2026-10-03', pm5: 'Intervals: Distance 500m, 2:00 rest, 5 reps', how: 'Fast but repeatable. Same split every time.' },
        { min: 19, name: '10 × 1:00 / 1:00 easy', date: '2026-11-10', pm5: 'Intervals: Time 1:00 work, 1:00 rest, 10 reps', how: 'Hard minutes, light pressure in between.' },
        { min: 19, name: '12 × 250m / 0:45 rest', date: '2026-10-22', pm5: 'Intervals: Distance 250m, 0:45 rest, 12 reps', how: 'Challenging. Sharp starts, hold form.' },
        { min: 20, name: '10 × 1:40 / 0:20 easy', date: '2026-10-28', pm5: 'Intervals: Time 1:40 work, 0:20 rest, 10 reps', how: 'Short recoveries. Settle into a rhythm.' },
        { min: 20, name: 'Triple Tabata', date: '2026-10-15', pm5: 'Intervals: Time 0:20 work, 0:10 rest, 8 reps; do it 3 times with 4:00 easy between', how: 'Hard. 20s on, 10s off, three sets.' },

        { min: 23, name: '1/2/3/4/5 min, 2:00 rest', date: '2026-11-03', pm5: 'Intervals: Variable (1:00, 2:00, 3:00, 4:00, 5:00; 2:00 rest)', how: 'Ladder. Start controlled, finish strong.' },
        { min: 25, name: '4 × 4:00 / 3:00 easy', date: '2026-10-24', pm5: 'Intervals: Time 4:00 work, 3:00 rest, 4 reps', how: 'Threshold feel. Even splits.' },
        { min: 26, name: '1/2/3/4/5/6 min, 1:00 rest', date: '2026-11-15', pm5: 'Intervals: Variable (1:00 up to 6:00; 1:00 rest)', how: 'Ladder up. Pace drops a little as pieces grow.' },
        { min: 29, name: '20 × 0:45 / 0:45', date: '2026-10-26', pm5: 'Intervals: Time 0:45 work, 0:45 rest, 20 reps', how: 'Equal work and rest. Keep every rep honest.' },
        { min: 29, name: '8/6/4/2 min, 3:00 easy', date: '2026-10-21', pm5: 'Intervals: Variable (8:00, 6:00, 4:00, 2:00; 3:00 rest)', how: 'Get faster as the pieces get shorter.' },
        { min: 29, name: '2000/1500/1000/500m, 3:00 easy', date: '2026-10-04', pm5: 'Intervals: Variable (2000m, 1500m, 1000m, 500m; 3:00 rest)', how: 'Descending ladder. Drop the pace each piece.' },

        { min: 31, name: '4/3/2/1/2/3/4 min, 2:00 rest', date: '2026-11-07', pm5: 'Intervals: Variable (4,3,2,1,2,3,4 min; 2:00 rest)', how: 'Pyramid. Short ones fast, long ones steady.' },
        { min: 31, name: '4 × 1000m / 5:00 easy', date: '2026-11-04', pm5: 'Intervals: Distance 1000m, 5:00 rest, 4 reps', how: 'Part of the 2k predictor series. Near 2k pace.' },
        { min: 34, name: '6 × 1000m / 2:00 rest', date: '2026-10-08', pm5: 'Intervals: Distance 1000m, 2:00 rest, 6 reps', how: 'Threshold. Hold your threshold band all the way.' },
        { min: 41, name: '1-2-3-4-5-4-3-2-1 min, 2:00 rest', date: '2026-11-01', pm5: 'Intervals: Variable (1 up to 5 and back; 2:00 rest)', how: 'Big pyramid. Pace yourself to the top.' },
        { min: 50, name: '50:00 steady', date: '2026-11-06', pm5: 'Single Time 50:00 (splits 5:00)', how: 'Concept2\'s 50th anniversary row. Zone 2.' },
    ],

    // Workouts that fit under `max` minutes and over the bucket below it.
    inBucket(max) {
        const i = wodLogic.BUCKETS.indexOf(max);
        const lo = i > 0 ? wodLogic.BUCKETS[i - 1] : 0;
        return wodLogic.WODS.filter(w => w.min > lo && w.min <= max);
    },
};

if (typeof module !== 'undefined') {
    module.exports = { wodLogic };
}
