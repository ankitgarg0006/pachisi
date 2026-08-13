// simtest.mjs — headless full-game Ludo sims (temp). Verifies termination,
// legal-only moves, capture/finish, and coordinate integrity.
import * as E from './public/engine.js';

function newGame(n, seed) {
  const g = { phase: 'lobby', players: [], turn: null, ranking: [], winner: null, log: [], rngSeed: seed };
  for (let i = 0; i < n; i++) g.players.push(E.newPlayer(i, 'Bot' + i, true));
  E.startGame(g);
  return g;
}

// integrity: every token maps to a valid cell
function checkCoords(g) {
  for (const p of g.players) for (let i = 0; i < 4; i++) {
    const c = E.cellOf(p.color, p.tokens[i], i);
    if (!c || !c.rc || c.rc.length !== 2) return `bad cell ${p.color} ${p.tokens[i]}`;
    const [r, cc] = c.rc;
    if (r < 0 || r > 14 || cc < 0 || cc > 14) return `oob ${p.color} pos${p.tokens[i]} -> ${r},${cc}`;
  }
  return null;
}

let fails = 0;
for (let run = 0; run < 40; run++) {
  const n = 2 + (run % 3); // 2..4
  const g = newGame(n, 1000 + run * 7919);
  let steps = 0, winner = null;
  while (steps++ < 20000) {
    const seat = g.turn.activeSeat;
    const r = E.roll(g, seat);
    if (r.forfeit || r.noMove) {
      // no move: pass (unless bonus loop — forfeit always passes)
      E.nextTurn(g);
    } else {
      const pick = E.botPick(g, seat);
      if (!g.turn.movable.includes(pick)) { console.log(run, 'ILLEGAL PICK', pick, g.turn.movable); fails++; break; }
      const res = E.applyMove(g, seat, pick);
      if (!res.ok) { console.log(run, 'MOVE REJECTED'); fails++; break; }
      const bad = checkCoords(g);
      if (bad) { console.log(run, bad); fails++; break; }
      const win = E.checkWin(g);
      if (win) { winner = win; break; }
      if (!res.bonus) E.nextTurn(g);
    }
    // guard: three-six forfeit resets sixes via beginTurn on nextTurn
  }
  if (winner) {
    const top = winner[0];
    if (top.home !== 4) { console.log(run, 'WINNER not 4 home', top); fails++; }
    else console.log(`run ${run}: ${n}p, ${top.name} won (4 home) in ${steps} steps`);
  } else { console.log(run, 'NO WINNER in', steps); fails++; }
}
console.log(fails === 0 ? 'ALL SIMS PASSED' : fails + ' FAILURES');
