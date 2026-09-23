// Filters applied to terminal byte streams between screen and the browser.

// GNU screen switches the attaching terminal to the alternate screen buffer
// (\e[?1049h) on attach and back on detach, and with `altscreen on` it also
// forwards vim/less/htop's own switches. xterm.js keeps NO scrollback for the
// alternate buffer, so everything a session printed was unscrollable and
// gone on the next redraw. Dropping the switches keeps the whole stream in
// xterm's normal buffer, where native scrolling and selection just work.
//
// Mouse tracking (vim, htop, some Ink apps) is dropped for the same reason:
// once a program turns it on, xterm.js hands every click and drag to the
// program as a mouse report instead of making a selection. termi never
// forwards those reports anyway, so the modes only cost the user copy.
const ALT_RE = /\x1b\[\?(?:1049|1047|47|100[0-6]|101[56])[hl]/g;
// A sequence can straddle two pty chunks — hold back a trailing private-mode
// prefix (ESC, ESC[, ESC[?, ESC[?digits) that could still complete into one.
const PARTIAL_RE = /\x1b(?:\[(?:\?[0-9;]*)?)?$/;

function altScreenFilter() {
  let carry = '';
  return (chunk) => {
    let s = carry + chunk;
    carry = '';
    const m = PARTIAL_RE.exec(s);
    if (m) { carry = m[0]; s = s.slice(0, m.index); }
    return s.replace(ALT_RE, '');
  };
}

// `screen -X hardcopy -h` dumps the window plus its scrollback, one physical
// row per line, padded to the window height. Trim the noise.
function cleanHardcopy(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  return lines.join('\n');
}

module.exports = { altScreenFilter, cleanHardcopy };
