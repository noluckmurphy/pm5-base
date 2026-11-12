# tv/

A big-screen display for rowing with a TV in front of the erg. It connects to
the PM5 like `example/` does, but shows only a few numbers, sized to read from
across the room:

* **Split**, coloured against the day's target band (green on target, amber
  slow, red more than 2s slow, blue faster than target), with a pace boat
  showing metres ahead of or behind a boat holding the middle of the band.
* **Stroke rate** against the target rate range.
* **Heart rate** coloured by zone (pair the strap to the PM5 so it comes
  through the PM5's own data).
* Meters, time (switching to "to go" when the PM5 knows the piece length),
  average split and watts.
* A strip of recent split/interval averages, and a rest countdown between
  intervals.

Session presets (threshold, max, 2k test, Zone 2) live in `tv-logic.js`.
The settings dialog can override them for one session, and changes HR zones.
Settings are kept in the browser's local storage.

Run it locally with `python3 -m http.server 8000` from the repo root and open
`http://localhost:8000/tv/`. Pick **Demo workout** to try it with no PM5.

To get it on the TV: HDMI from the Mac, or Chrome's menu → Cast → Cast tab.
Press **F** for full screen and **S** for settings. The top bar hides while
you row; move the mouse to bring it back.

The maths is in `tv-logic.js` and is pinned by `test/tv-logic.test.mjs`.
`app.js` is DOM glue. `window.pm5tv.inject({...})` feeds fake PM5 data in
from the console for checking layouts (rest, finished, HR zones).
