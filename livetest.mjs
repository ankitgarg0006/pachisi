// livetest.mjs — live WS smoke test against chausar.agapps.workers.dev (temp).
const BASE = 'https://chausar.agapps.workers.dev', WS = 'wss://chausar.agapps.workers.dev';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('✓', n); } else { fail++; console.log('✗', n); } };

// 1) bots room: create, connect, expect autostart + bots rolling/moving + a winner path
const create = await (await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2, visibility: 'bots', name: 'Smoke', timed: false }) })).json();
ok('create bots room', /^\d{6}$/.test(create.code || '') && !!create.token);

let sawRoll = false, sawMove = false, myTurns = 0, reachedOver = false, states = [], checkedStart = false;
function ok0(s) { if (checkedStart) return; checkedStart = true; ok('game started, tokens present', s.players[0].tokens.length === 4 && !!s.players[0].color); }
await new Promise((resolve) => {
  const ws = new WebSocket(`${WS}/api/rooms/${create.code}/ws?token=${create.token}`);
  const done = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 40000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') ok('welcome seat 0', m.you.seat === 0);
    if (m.type === 'event') { if (m.e.t === 'roll') sawRoll = true; if (m.e.t === 'move') sawMove = true; }
    if (m.type === 'state') {
      states.push(m.state);
      const s = m.state;
      if (s.phase === 'playing') {
        ok0(s);
        if (s.turn.activeSeat === 0) {
          myTurns++;
          if (s.turn.phase === 'roll') ws.send(JSON.stringify({ type: 'roll' }));
          else if (s.turn.phase === 'move' && s.turn.movable.length) ws.send(JSON.stringify({ type: 'move', token: s.turn.movable[0] }));
        }
      }
      if (s.phase === 'over') { reachedOver = true; clearTimeout(done); try { ws.close(); } catch {} resolve(); }
    }
  };
  ws.onerror = () => { ok('ws connect', false); clearTimeout(done); resolve(); };
});
ok('bot/self rolled', sawRoll);
ok('a token moved', sawMove);
ok('I took turns', myTurns > 0);
ok('reached game over OR progressed', reachedOver || states.length > 20);

// 2) public room + join + start-lock + chat
const pub = await (await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: 2, visibility: 'public', name: 'PubHost' }) })).json();
const list = await (await fetch(BASE + '/api/rooms')).json();
ok('public room listed', (list.rooms || []).some((r) => r.code === pub.code));
let guestSeat = -1, gotChat = false, guestToken = '';
await new Promise((resolve) => {
  const host = new WebSocket(`${WS}/api/rooms/${pub.code}/ws?token=${pub.token}`);
  const to = setTimeout(resolve, 20000);
  host.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'chat' && m.msg.text === 'hi') gotChat = true;
    if (m.type === 'welcome') {
      const guest = new WebSocket(`${WS}/api/rooms/${pub.code}/ws?name=Guest`);
      guest.onmessage = (e2) => {
        const m2 = JSON.parse(e2.data);
        if (m2.type === 'welcome') { guestSeat = m2.you.seat; guestToken = m2.you.token; guest.send(JSON.stringify({ type: 'chat', text: 'hi' })); setTimeout(() => host.send(JSON.stringify({ type: 'start' })), 600); }
        if (m2.type === 'state' && m2.state.phase === 'playing') {
          const late = new WebSocket(`${WS}/api/rooms/${pub.code}/ws?name=Late`);
          late.onmessage = (e3) => { const m3 = JSON.parse(e3.data); if (m3.type === 'error') { ok('start-lock rejects late joiner', m3.code === 'in-progress' || m3.code === 'full'); clearTimeout(to); resolve(); } };
          late.onerror = () => { ok('start-lock rejects late joiner', true); clearTimeout(to); resolve(); };
        }
      };
    }
  };
  host.onerror = () => { clearTimeout(to); resolve(); };
});
ok('guest seated', guestSeat === 1);
ok('chat delivered', gotChat);

// 3) reconnect
await new Promise((resolve) => {
  const re = new WebSocket(`${WS}/api/rooms/${pub.code}/ws?token=${guestToken}`);
  const to = setTimeout(() => { ok('reconnect', false); resolve(); }, 8000);
  re.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'welcome') { ok('reconnect same seat', m.you.seat === 1); clearTimeout(to); try { re.close(); } catch {} resolve(); } };
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
