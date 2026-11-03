// Commands termi sends INTO a screen session from outside, via
// `screen -S <session> -X <command>`. These run inside the session process
// no matter which displays are attached, which is what makes them reliable.

// Session names are "pid.name"; they go into a shell command, so be strict.
const SAFE_SESSION = /^[\w.\-]+$/;

// Anything a phone or a laptop can plausibly show. screen rejects absurd
// sizes on its own, but garbage must never reach the command line either.
const MIN_COLS = 10, MAX_COLS = 1000, MIN_ROWS = 3, MAX_ROWS = 500;

function windowSize(cols, rows) {
  cols = Math.trunc(Number(cols)); rows = Math.trunc(Number(rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) return null;
  return { cols, rows };
}

// Resize the WINDOW (what the program inside sees) to cols×rows. The program
// gets SIGWINCH and every attached display is redrawn at that size.
//
// A screen window has one size shared by all displays showing it, and
// `screen -A` only adapts it while the window is on a single display. A
// watched session always has the hub's watcher display attached, a laptop
// may be attached too, and a previous termi attach can still be winding
// down — in all those cases -A silently does nothing and a phone is left
// looking at a 48-column slice of a 200-column window. `width -w` sets the
// window size unconditionally.
function windowSizeCmd(sessionName, cols, rows) {
  if (typeof sessionName !== 'string' || !SAFE_SESSION.test(sessionName)) return null;
  const size = windowSize(cols, rows);
  if (!size) return null;
  return `screen -S ${sessionName} -X width -w ${size.cols} ${size.rows}`;
}

module.exports = { SAFE_SESSION, windowSize, windowSizeCmd };
