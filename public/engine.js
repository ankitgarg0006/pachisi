// engine.js — Chausar (Ludo) pure engine. Shared by the LudoRoom DO and the
// pass-and-play client. No storage / network / DOM. Deterministic RNG in
// state.rngSeed. Classic rules: need a 6 to leave, capture sends home, ★ safe
// squares, exact roll to finish, bonus roll on 6 / capture / finishing a token,
// three 6s forfeit. Single 6-face die. © agapps

// ---------------------------------------------------------------------------
// RNG (mulberry32)
// ---------------------------------------------------------------------------
function rng(state) {
  let t = (state.rngSeed = (state.rngSeed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Board geometry — 15×15 grid, 0-indexed [row, col].
// RING = the 52-cell main track (clockwise). Each colour enters at START_IX and
// travels 51 ring cells, then 6 home-column cells (last = finish, pos 57).
// ---------------------------------------------------------------------------
export const RING = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],[6,0],
]; // 52 cells

export const START_IX = { red: 0, green: 13, yellow: 26, blue: 39 };

// Home columns: 6 cells each, index [pos-52]; the 6th (index 5) is the finish
// (adjacent to the centre 7,7). Colours: red=TL, green=TR, yellow=BR, blue=BL.
export const HOME = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};

// Yard slots (fractional [row,col] centres inside each 6×6 base block).
export const YARD = {
  red:    [[1.3,1.3],[1.3,3.7],[3.7,1.3],[3.7,3.7]],
  green:  [[1.3,10.3],[1.3,12.7],[3.7,10.3],[3.7,12.7]],
  yellow: [[10.3,10.3],[10.3,12.7],[12.7,10.3],[12.7,12.7]],
  blue:   [[10.3,1.3],[10.3,3.7],[12.7,1.3],[12.7,3.7]],
};

// Base block top-left corners + which screen corner they occupy.
export const BASE = {
  red:    { r: 0, c: 0, corner: 'tl' },
  green:  { r: 0, c: 9, corner: 'tr' },
  yellow: { r: 9, c: 9, corner: 'br' },
  blue:   { r: 9, c: 0, corner: 'bl' },
};

export const COLORS = ['red', 'green', 'yellow', 'blue'];
// Safe ring cells: the four start squares + four star squares (start+8).
export const SAFE_IX = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
export const FINISH = 57;

// Colour assignment by player count (2p = diagonal opposites).
function colorsFor(n) {
  if (n <= 2) return ['red', 'yellow'];
  if (n === 3) return ['red', 'green', 'yellow'];
  return ['red', 'green', 'yellow', 'blue'];
}

// Ring index a token currently sits on (only valid for pos 1..51).
export function ringIndexOf(color, pos) {
  return (START_IX[color] + pos - 1) % 52;
}

// Render coordinate for a token: {kind:'yard'|'ring'|'home', rc:[r,c]}.
export function cellOf(color, pos, tokenIndex) {
  if (pos === 0) return { kind: 'yard', rc: YARD[color][tokenIndex] };
  if (pos <= 51) return { kind: 'ring', rc: RING[ringIndexOf(color, pos)] };
  return { kind: 'home', rc: HOME[color][pos - 52] };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function newPlayer(seat, name, isBot) {
  return { seat, name, isBot, connected: isBot, ready: isBot, color: null, pref: null, tokens: [0, 0, 0, 0], finished: 0 };
}

// Assign board colours: honour each player's chosen `pref`, then fill the rest.
// With no prefs, 2 players take diagonal opposites (red & yellow).
export function assignColors(g) {
  const taken = new Set();
  for (const p of g.players) {
    if (p.pref && COLORS.includes(p.pref) && !taken.has(p.pref)) { p.color = p.pref; taken.add(p.pref); }
    else p.color = null;
  }
  const pool = (g.players.length <= 2 ? ['red', 'yellow', 'green', 'blue'] : COLORS).filter((c) => !taken.has(c));
  let ri = 0;
  for (const p of g.players) if (!p.color) p.color = pool[ri++];
}

export function startGame(g) {
  g.phase = 'playing';
  g.winner = null;
  g.ranking = [];
  assignColors(g);
  g.players.forEach((p) => { p.tokens = [0, 0, 0, 0]; p.finished = 0; });
  beginTurn(g, 0);
}

export function beginTurn(g, seat) {
  g.turn = { activeSeat: seat, phase: 'roll', die: 0, sixes: 0, movable: [], moved: false, lastMoved: -1, deadline: 0 };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
export function legalMoves(g, seat, die) {
  const p = g.players[seat];
  const moves = [];
  for (let i = 0; i < 4; i++) {
    const pos = p.tokens[i];
    if (pos === FINISH) continue;
    if (pos === 0) { if (die === 6) moves.push(i); continue; }
    if (pos + die <= FINISH) moves.push(i);
  }
  return moves;
}

function opponentTokensOn(g, seat, ringIx) {
  const hits = [];
  for (const q of g.players) {
    if (q.seat === seat) continue;
    for (let j = 0; j < 4; j++) {
      const pos = q.tokens[j];
      if (pos >= 1 && pos <= 51 && ringIndexOf(q.color, pos) === ringIx) hits.push([q.seat, j]);
    }
  }
  return hits;
}

// Roll the die for the active seat. Updates g.turn (die, sixes, movable, phase).
export function roll(g, seat) {
  const die = 1 + Math.floor(rng(g) * 6);
  g.turn.die = die;
  if (die === 6) g.turn.sixes = (g.turn.sixes || 0) + 1;
  else g.turn.sixes = 0;
  // Three consecutive 6s: the third is void, turn forfeits.
  if (g.turn.sixes >= 3) {
    g.turn.movable = [];
    g.turn.phase = 'roll';
    return { die, forfeit: true, movable: [] };
  }
  const movable = legalMoves(g, seat, die);
  g.turn.movable = movable;
  g.turn.phase = movable.length ? 'move' : 'roll';
  return { die, movable, noMove: movable.length === 0 };
}

// Apply the active seat moving token i by the current die. Returns
// { ok, events, bonus, win, captured, finished }.
export function applyMove(g, seat, i) {
  if (g.turn.phase !== 'move' || !g.turn.movable.includes(i)) return { ok: false };
  const die = g.turn.die;
  const p = g.players[seat];
  const events = [];
  let pos = p.tokens[i];
  const from = pos;
  pos = pos === 0 ? 1 : pos + die;
  p.tokens[i] = pos;
  let captured = false, finished = false;
  if (pos === FINISH) {
    finished = true;
    p.finished = p.tokens.filter((t) => t === FINISH).length;
    events.push({ t: 'move', seat, token: i, from, to: pos });
    events.push({ t: 'home', seat, token: i });
  } else {
    events.push({ t: 'move', seat, token: i, from, to: pos });
    if (pos <= 51) {
      const ix = ringIndexOf(p.color, pos);
      if (!SAFE_IX.has(ix)) {
        const hits = opponentTokensOn(g, seat, ix);
        for (const [vs, vj] of hits) {
          g.players[vs].tokens[vj] = 0;
          captured = true;
          events.push({ t: 'capture', by: seat, victim: vs, token: vj });
        }
      }
    }
  }
  g.turn.moved = true;
  g.turn.lastMoved = i;
  const win = p.tokens.every((t) => t === FINISH);
  const bonus = !win && (die === 6 || captured || finished);
  return { ok: true, events, bonus, win, captured, finished };
}

export function allFinished(p) {
  return p.tokens.every((t) => t === FINISH);
}

// Advance to the next seat that still has tokens to move.
export function nextTurn(g) {
  const n = g.players.length;
  let s = g.turn.activeSeat;
  for (let k = 0; k < n; k++) {
    s = (s + 1) % n;
    if (!allFinished(g.players[s])) break;
  }
  beginTurn(g, s);
}

export function checkWin(g) {
  for (const p of g.players) {
    if (allFinished(p) && g.ranking.indexOf(p.seat) < 0) g.ranking.push(p.seat);
  }
  // Game ends when only one (or zero) player still has tokens in play, or the
  // first player finishes all four (classic "first home wins").
  const first = g.players.find((p) => allFinished(p));
  if (first) {
    g.phase = 'over';
    g.winner = first.seat;
    return standings(g);
  }
  return null;
}

export function progress(p) {
  return p.tokens.reduce((s, t) => s + t, 0);
}

export function standings(g) {
  const rows = g.players.map((p) => ({
    seat: p.seat, name: p.name, isBot: p.isBot, color: p.color,
    home: p.tokens.filter((t) => t === FINISH).length,
    progress: progress(p),
  }));
  rows.sort((a, b) => b.home - a.home || b.progress - a.progress);
  return rows;
}

// ---------------------------------------------------------------------------
// Per-seat view (Ludo has no hidden info; just strip internals).
// ---------------------------------------------------------------------------
export function viewFor(g) {
  const v = JSON.parse(JSON.stringify(g));
  delete v.rngSeed;
  return v;
}

// ---------------------------------------------------------------------------
// Bots — pick which token to move (roll is automatic).
// ---------------------------------------------------------------------------
export function botPick(g, seat) {
  const p = g.players[seat];
  const die = g.turn.die;
  const moves = g.turn.movable;
  if (moves.length <= 1) return moves[0];
  let best = moves[0], bestScore = -1e9;
  for (const i of moves) {
    const pos = p.tokens[i];
    const to = pos === 0 ? 1 : pos + die;
    let score = to; // baseline: advance progress
    if (to === FINISH) score += 1000;
    if (to <= 51) {
      const ix = ringIndexOf(p.color, to);
      if (!SAFE_IX.has(ix) && opponentTokensOn(g, seat, ix).length) score += 500; // capture
      if (SAFE_IX.has(ix)) score += 45; // reach safety
      // discourage sitting on an unsafe square right in front of a rival
      if (!SAFE_IX.has(ix) && threatened(g, seat, ix)) score -= 60;
    }
    if (pos === 0 && die === 6) score += 130; // bring a token out
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// Is ring cell ix within 6 behind an opponent token (capture risk)?
function threatened(g, seat, ix) {
  for (const q of g.players) {
    if (q.seat === seat) continue;
    for (let j = 0; j < 4; j++) {
      const pos = q.tokens[j];
      if (pos < 1 || pos > 51) continue;
      const qix = ringIndexOf(q.color, pos);
      const gap = (ix - qix + 52) % 52;
      if (gap >= 1 && gap <= 6) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
export function log(g, msg) {
  if (!g.log) g.log = [];
  g.log.push(msg);
  if (g.log.length > 24) g.log.shift();
}
