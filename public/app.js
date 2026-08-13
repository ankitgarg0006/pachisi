// app.js — Pachisi (Ludo) client. Renders the cloth board + tokens from server
// (or local pass-and-play) state; four corner trays, tap-to-roll, tap-to-move.
// © agapps
import * as E from './engine.js';

/* ============ helpers ============ */
const $ = (s, r) => (r || document).querySelector(s);
const app = document.getElementById('app');
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return n;
}
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const myName = () => store.get('lu_name', '') || 'Player';
const soundOn = () => store.get('lu_sound', '1') === '1';
const animOn = () => store.get('lu_anim', '1') === '1' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDesktop = () => matchMedia('(min-width: 980px)').matches;
const COLVAR = { red: 'var(--red)', green: 'var(--grn)', yellow: 'var(--yel)', blue: 'var(--blue)' };

function applyTheme() {
  const t = store.get('lu_theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

let actx = null;
function beep(f, d = 0.07, type = 'triangle', g = 0.04) {
  if (!soundOn()) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), gn = actx.createGain();
    o.type = type; o.frequency.value = f;
    gn.gain.setValueAtTime(g, actx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d);
    o.connect(gn).connect(actx.destination); o.start(); o.stop(actx.currentTime + d);
  } catch { /* no audio */ }
}
// Filtered noise burst — a real "rattle", ported from Bazaar Baron.
function noiseBurst(dur, freq, q, vol, when) {
  if (!soundOn()) return;
  try {
    const ac = actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ac.currentTime + (when || 0);
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq || 1200; bp.Q.value = q || 1;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(ac.destination);
    src.start(t0); src.stop(t0 + dur + 0.03);
  } catch { /* no audio */ }
}
const snd = {
  dice: () => { noiseBurst(0.55, 2600, 0.8, 0.15); for (let i = 0; i < 4; i++) noiseBurst(0.05, 1700, 3, 0.22, 0.12 + i * 0.14); },
  land: () => { beep(200, .09, 'triangle', .05); setTimeout(() => beep(320, .06, 'triangle', .035), 60); },
  move: () => beep(560, .05),
  capture: () => { beep(200, .12, 'sawtooth', .05); setTimeout(() => beep(150, .12, 'sawtooth', .04), 90); },
  home: () => { [523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, .1, 'sine', .045), i * 90)); },
  turn: () => beep(440, .08, 'sine'),
  bad: () => beep(180, .1, 'sawtooth', .045),
  win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, .12, 'sine', .05), i * 130)); },
};

/* ============ session ============ */
let net = null;   // { ws, code, seat, token, S }
let local = null; // { g, humans, botTimer }
let ui = { chatTab: 'log', chatOpen: false, unread: 0 };
let clock = null;
let overShown = false;

/* ============ router ============ */
function go(fn) { closeOverlays(); app.replaceChildren(); fn(); window.scrollTo(0, 0); }
function closeOverlays() { for (const n of document.querySelectorAll('.dim,.sheet,.modal,.toast,.flymsg,.flyemo,.fx')) n.remove(); }

window.addEventListener('load', () => {
  const m = location.hash.match(/^#\/(j|t)\/(\d{6})$/);
  if (m && m[1] === 'j') { go(() => renderJoin(m[2])); return; }
  if (m && m[1] === 't') {
    const token = store.get('lu_token_' + m[2], '');
    if (token) { connect(m[2], { token }); return; }
  }
  if (restoreLocal()) return; // resume an in-progress pass & play game after a refresh
  go(renderHome);
});

/* ============ HOME ============ */
// A real 3D die: a preserve-3d cube with six pipped faces. Opposite faces sum
// to 7 (1-6, 2-5, 3-4). showFace() rotates the cube so face n sits up front.
// At REST the cube sits nearly straight-on (TILT ≈ identity) so ONLY the rolled
// face is visible — a die photographed head-on. Depth comes from a bevelled edge
// + a cast shadow in CSS. The throw still tumbles the whole cube through spins.
const PIPLAY = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const DIE_FACES = [['fz', 1], ['fb', 6], ['fr', 3], ['fl', 4], ['ft', 2], ['fo', 5]]; // front/back/right/left/top/bottom
const SHOWN = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] }; // [rotX,rotY] to bring face n forward
const TILT = 'scale(.94)';
function makeDie(n) {
  const die = el('div', { class: 'die' });
  const cube = el('div', { class: 'cube' });
  for (const [cls, val] of DIE_FACES) {
    const f = el('div', { class: 'face ' + cls });
    for (let i = 0; i < 9; i++) { const p = el('div', {}); if (PIPLAY[val].includes(i)) p.className = 'pip'; f.append(p); }
    cube.append(f);
  }
  die.append(cube); die._cube = cube;
  showFace(die, n || 1);
  return die;
}
function showFace(die, n) {
  const cube = die._cube || die.querySelector('.cube'); if (!cube) return;
  const [x, y] = SHOWN[n] || [0, 0];
  cube.style.transition = 'none';
  cube.style.transform = `${TILT} rotateX(${x}deg) rotateY(${y}deg)`;
  die.dataset.face = n;
}
function dieFace(n) { return makeDie(n); } // used by the home hero + trays

// Roll: tumble the cube through several full turns and land on `final` — a real
// 3D throw. Extra whole turns are ≡ the rest angle mod 360, so settling is seamless.
let rollAnim = null, pendingUpdate = false;
function animateRoll(seat, final) {
  const d = $('#activedie'); const cube = d && (d._cube || d.querySelector('.cube'));
  if (!animOn() || !cube) { if (d) showFace(d, final); return; }
  rollAnim = { seat };
  snd.dice();
  d.classList.remove('land', 'idle'); d.classList.add('rolling');
  const [fx, fy] = SHOWN[final] || [0, 0];
  const spinX = 360 * 3 + fx, spinY = 360 * 4 + fy;
  cube.style.transition = 'transform .74s cubic-bezier(.22,.62,.28,1)';
  void cube.offsetWidth; // reflow so the transition takes
  cube.style.transform = `${TILT} rotateX(${spinX}deg) rotateY(${spinY}deg)`;
  setTimeout(() => {
    if (!rollAnim) return;
    d.classList.remove('rolling');
    showFace(d, final); // normalise to the equivalent rest angle (no visual jump)
    d.classList.add('land'); snd.land();
    setTimeout(() => { rollAnim = null; pendingUpdate = false; updateGame(); }, 150);
  }, 740);
}
function renderHome() {
  location.hash = '';
  const live = el('div', { class: 'livepill' }, '· · ·');
  fetch('/api/rooms').then((r) => r.json()).then((j) => {
    const rooms = j.rooms || [];
    const n = rooms.reduce((s, r) => s + r.players, 0);
    live.textContent = rooms.length ? `● ${n} player${n === 1 ? '' : 's'} across ${rooms.length} open board${rooms.length === 1 ? '' : 's'}` : '● Open a board — friends join with a code';
  }).catch(() => { live.textContent = '● Offline — Pass & Play still works'; });

  const bigDie = dieFace(6); bigDie.classList.add('big');
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }),
      el('button', { class: 'iconbtn', onclick: cycleTheme, title: 'Theme' }, themeIcon()),
      el('button', { class: 'iconbtn', onclick: () => go(renderSettings), title: 'Settings' }, '⚙')),
    el('div', { class: 'home-hero' },
      el('div', { class: 'h-logo' }, 'PACHISI'),
      el('div', { class: 'h-tag' }, 'ROLL THE DIE · BRING ALL FOUR HOME'),
      el('div', { class: 'h-dice' }, bigDie)),
    el('div', { class: 'menu' },
      el('button', { class: 'mitem primary', onclick: quickMatch }, '⚡', el('span', {}, 'Play Online', el('small', {}, 'quick-match a public board'))),
      el('button', { class: 'mitem', onclick: () => go(renderCreate) }, '➕', el('span', {}, 'Create Room', el('small', {}, 'private or public · 2–4 players · bots'))),
      el('button', { class: 'mitem', onclick: () => go(() => renderJoin('')) }, '🔑', el('span', {}, 'Join Room', el('small', {}, 'enter a 6-digit code'))),
      el('button', { class: 'mitem', onclick: () => go(renderPassSetup) }, '🤝', el('span', {}, 'Pass & Play', el('small', {}, 'one phone around the table')))),
    live,
    el('div', { class: 'foot-c' }, el('a', { href: '#', onclick: (e) => { e.preventDefault(); go(renderHowto); } }, 'HOW TO PLAY'), '  ·  © AGAPPS')));
}
function themeIcon() { const t = store.get('lu_theme', 'system'); return t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐'; }
function cycleTheme() { const o = ['system', 'dark', 'light']; const c = store.get('lu_theme', 'system'); store.set('lu_theme', o[(o.indexOf(c) + 1) % o.length]); applyTheme(); const b = $('.iconbtn'); if (b) b.textContent = themeIcon(); }

async function quickMatch() {
  try { const j = await (await fetch('/api/rooms')).json(); const open = (j.rooms || [])[0]; if (open) { await joinRoom(open.code, myName()); return; } } catch { /* fall through */ }
  await createRoom({ seats: 4, visibility: 'public', bots: false, timed: false });
}

/* ============ CREATE ============ */
function renderCreate() {
  let seats = 4, bots = true, vis = 'private', timer = 0;
  const nameIn = el('input', { class: 'f-in', maxlength: 20, placeholder: 'Your name', value: store.get('lu_name', '') });
  const err = el('div', { class: 'err' });
  const seg = (opts, cur, onpick) => { const w = el('div', { class: 'seg' }); for (const o of opts) w.append(el('button', { class: 's' + (o.v === cur ? ' on' : ''), onclick: () => { onpick(o.v); [...w.children].forEach((c, i) => c.classList.toggle('on', opts[i].v === o.v)); } }, o.l)); return w; };
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('button', { class: 'iconbtn', onclick: () => go(renderHome) }, '✕')),
    el('div', { class: 'title' }, 'CREATE ROOM'),
    el('div', { class: 'f-lab' }, 'Your name'), nameIn,
    el('div', { class: 'f-lab' }, 'Players'), seg([2, 3, 4].map((n) => ({ v: n, l: String(n) })), seats, (v) => seats = v),
    el('div', { class: 'f-lab' }, 'Fill empty seats with bots'), seg([{ v: true, l: 'Yes' }, { v: false, l: 'No' }], bots, (v) => bots = v),
    el('div', { class: 'f-lab' }, 'Room type'), seg([{ v: 'private', l: 'Private' }, { v: 'public', l: 'Public' }], vis, (v) => vis = v),
    el('div', { class: 'f-lab' }, 'Turn timer'), seg([{ v: 0, l: 'Off' }, { v: 30, l: '30s' }, { v: 60, l: '60s' }], timer, (v) => timer = v),
    err,
    el('div', { style: 'margin-top:auto;' }, el('button', { class: 'btn p', onclick: async (ev) => {
      const name = nameIn.value.trim() || 'Host'; store.set('lu_name', name); ev.target.disabled = true;
      try { await createRoom({ seats, visibility: bots && vis === 'private' ? 'private' : vis, bots, timed: timer > 0, turnSeconds: timer, name }); }
      catch { err.textContent = 'Could not create the board. Try again.'; ev.target.disabled = false; }
    } }, 'CREATE BOARD'))));
}
async function createRoom(opts) {
  const name = opts.name || myName();
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: opts.seats, visibility: opts.visibility, name, timed: opts.timed, turnSeconds: opts.turnSeconds }) });
  const j = await res.json();
  if (!j.code) throw new Error('create-failed');
  store.set('lu_token_' + j.code, j.token);
  connect(j.code, { token: j.token, addBots: opts.bots ? opts.seats - 1 : 0 });
}

/* ============ JOIN ============ */
function renderJoin(prefill) {
  const nameIn = el('input', { class: 'f-in', maxlength: 20, placeholder: 'Your name', value: store.get('lu_name', '') });
  const codeIn = el('input', { class: 'f-in', inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code', value: prefill || '', style: 'letter-spacing:.3em;text-align:center;font-size:19px;' });
  const err = el('div', { class: 'err' });
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:7px;' });
  fetch('/api/rooms').then((r) => r.json()).then((j) => {
    const rooms = j.rooms || [];
    if (!rooms.length) { list.append(el('div', { class: 'err', style: 'color:var(--tx2)' }, 'No open public boards right now.')); return; }
    for (const r of rooms) list.append(el('button', { class: 'prow', style: 'width:100%;', onclick: () => codeIn.value = r.code }, el('span', { class: 'dot', style: 'background:var(--brass)' }), `${r.host}'s board`, el('span', { class: 'tag' }, `${r.players}/${r.capacity}`)));
  }).catch(() => { /* offline */ });
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('button', { class: 'iconbtn', onclick: () => go(renderHome) }, '✕')),
    el('div', { class: 'title' }, 'JOIN ROOM'),
    el('div', { class: 'f-lab' }, 'Your name'), nameIn,
    el('div', { class: 'f-lab' }, 'Board code'), codeIn, err,
    el('button', { class: 'btn p', style: 'margin-top:10px;', onclick: async () => {
      const code = codeIn.value.trim(); if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
      const name = nameIn.value.trim() || 'Player'; store.set('lu_name', name);
      try { await joinRoom(code, name, err); } catch { /* shown */ }
    } }, 'JOIN BOARD'),
    el('div', { class: 'f-lab', style: 'margin-top:18px;' }, 'Open public boards'), list));
}
async function joinRoom(code, name, errEl) {
  const info = await (await fetch('/api/rooms/' + code)).json();
  if (!info.exists) { if (errEl) errEl.textContent = 'Board not found.'; throw new Error('nf'); }
  if (info.phase !== 'lobby') { if (errEl) errEl.textContent = 'That game already started.'; throw new Error('started'); }
  connect(code, { name });
}

/* ============ NETWORK ============ */
function connect(code, opts) {
  if (net && net.ws) { try { net.ws.close(); } catch { /* ignore */ } }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = opts.token ? 'token=' + encodeURIComponent(opts.token) : 'name=' + encodeURIComponent(opts.name || myName());
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
  net = { ws, code, seat: null, token: opts.token || null, S: null, addBots: opts.addBots || 0 };
  local = null; clearLocal(); overShown = false;
  go(() => app.append(el('div', { class: 'screen' }, el('div', { class: 'title', style: 'margin:auto;' }, 'CONNECTING…'))));
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'welcome') {
      net.seat = m.you.seat; net.token = m.you.token; store.set('lu_token_' + code, m.you.token); location.hash = '#/t/' + code; net.S = m.state;
      if (net.addBots > 0 && net.seat === 0) { const want = Math.min(net.addBots, m.state.capacity - m.state.players.length); for (let i = 0; i < want; i++) ws.send(JSON.stringify({ type: 'addBot' })); net.addBots = 0; }
      renderFromState();
    } else if (m.type === 'state') { net.S = m.state; renderFromState(); }
    else if (m.type === 'event') { onEvent(m.e); }
    else if (m.type === 'chat') { onChat(m.msg); }
    else if (m.type === 'over') { snd.win(); }
    else if (m.type === 'error') {
      if (['in-progress', 'no-room', 'bad-token'].includes(m.code)) { store.del('lu_token_' + code); go(renderHome); toast(m.msg || 'Could not join.'); }
      else { toast(m.msg || 'Not allowed.'); snd.bad(); }
    }
  };
  ws.onclose = () => {
    if (!net || net.ws !== ws) return;
    if (net.S && net.S.phase !== 'over') setTimeout(() => { if (net && net.ws === ws && net.token) connect(code, { token: net.token }); }, 1500);
  };
}
function send(msg) { if (local) { localSend(msg); return; } if (net && net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(msg)); }

/* ============ STATE → SCREEN ============ */
function S() { return local ? local.g : (net && net.S); }
function mySeat() {
  if (local) { const a = local.g.turn ? local.g.turn.activeSeat : 0; return local.g.players[a] && !local.g.players[a].isBot ? a : null; }
  return net ? net.seat : null;
}
function renderFromState() {
  const s = S(); if (!s) return;
  if (s.phase === 'lobby') { go(renderLobby); return; }
  if (s.phase === 'playing' || s.phase === 'over') {
    if (!$('.play')) go(renderGame); else updateGame();
    if (s.phase === 'over') showGameOver();
  }
}

/* ============ LOBBY ============ */
function renderLobby() {
  const s = S(); const me = mySeatLobby(); const isHost = me === s.host;
  const rows = el('div', { style: 'display:flex;flex-direction:column;gap:7px;' });
  for (let i = 0; i < s.capacity; i++) {
    const p = s.players[i];
    if (!p) { rows.append(el('div', { class: 'prow empty' }, el('span', { class: 'dot', style: 'background:var(--pline)' }), 'Waiting for player…')); continue; }
    rows.append(el('div', { class: 'prow' }, el('span', { class: 'dot', style: 'background:' + (p.pref ? COLVAR[p.pref] : 'var(--pline)') }), p.name + (p.seat === me ? ' (you)' : ''), el('span', { class: 'tag' + (p.seat === s.host ? ' host' : '') }, p.seat === s.host ? 'HOST' : p.isBot ? 'BOT' : 'IN')));
  }
  // colour picker — claim an available colour (tap yours again to release)
  const swatches = el('div', { style: 'display:flex;gap:12px;justify-content:center;margin:2px 0 4px;' });
  for (const c of ['red', 'green', 'yellow', 'blue']) {
    const owner = s.players.find((p) => p.pref === c);
    const mineC = owner && owner.seat === me;
    const taken = owner && owner.seat !== me;
    const sw = el('button', { class: 'colorsw' + (mineC ? ' mine' : '') + (taken ? ' taken' : ''), style: `--pc:${COLVAR[c]}`,
      onclick: () => { if (!taken) send({ type: 'pickColor', color: c }); } });
    if (owner) sw.append(el('span', { class: 'own' }, (owner.name[0] || '?').toUpperCase()));
    swatches.append(sw);
  }
  const link = `${location.origin}/#/j/${s.code}`;
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('span', { class: 'pill' }, s.visibility.toUpperCase()), el('button', { class: 'iconbtn', onclick: leaveToHome }, '✕')),
    el('div', { class: 'code-l' }, 'Board code'), el('div', { class: 'code' }, s.code.slice(0, 3) + ' ' + s.code.slice(3)),
    el('button', { class: 'btn g', style: 'font-size:12px;padding:9px;', onclick: async () => { try { if (navigator.share) await navigator.share({ title: 'Pachisi', text: 'Join my Pachisi board!', url: link }); else { await navigator.clipboard.writeText(link); toast('Invite link copied'); } } catch { /* cancelled */ } } }, '🔗 SHARE INVITE LINK'),
    el('div', { style: 'height:6px;' }), rows,
    el('div', { class: 'f-lab', style: 'text-align:center;margin-top:10px;' }, 'Pick your colour (optional)'), swatches,
    isHost && s.players.length < s.capacity ? el('button', { class: 'btn q', onclick: () => send({ type: 'addBot' }) }, '+ Add a bot') : null,
    isHost && s.players.length && s.players[s.players.length - 1].isBot ? el('button', { class: 'btn q', onclick: () => send({ type: 'removeBot' }) }, '– Remove bot') : null,
    el('div', { style: 'margin-top:auto;display:flex;flex-direction:column;gap:8px;' },
      isHost ? el('button', { class: 'btn p', disabled: s.players.length < 2 ? '' : null, onclick: () => send({ type: 'start' }) }, 'START GAME') : el('div', { class: 'err', style: 'color:var(--tx2)' }, 'Waiting for the host to start…'))));
}
function mySeatLobby() { return net ? net.seat : 0; }
function leaveToHome() { if (net && net.ws) { try { net.ws.close(); } catch { /* ignore */ } net = null; } if (local && local.botTimer) clearTimeout(local.botTimer); local = null; clearLocal(); if (clock) { clearInterval(clock); clock = null; } go(renderHome); }

/* ============ GAME ============ */
let gotiEls = {};
function renderGame() {
  gotiEls = {};
  const wrap = el('div', { class: 'screen wide' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('span', { class: 'pill', id: 'turnpill' }, '…'), el('button', { class: 'iconbtn', onclick: openMenu }, '☰')),
    el('div', { class: 'gamegrid' },
      el('div', { class: 'play' },
        el('div', { class: 'trayrow', id: 'traytop' }),
        el('div', { class: 'boardwrap', id: 'boardwrap' }, buildBoard(), el('div', { class: 'tokens', id: 'tokens' })),
        el('div', { class: 'trayrow', id: 'traybot' }),
        el('div', { class: 'abar', id: 'abar' })),
      el('div', { class: 'rail', id: 'rail' })));
  app.append(wrap);
  if (!isDesktop()) app.append(el('button', { class: 'chatfab', id: 'chatfab', onclick: openChatSheet }, '💬'));
  if (clock) clearInterval(clock);
  clock = setInterval(updateClock, 500);
  updateGame();
}

// Static board grid built once.
function buildBoard() {
  const b = el('div', { class: 'board' });
  const cornerOf = { red: 'top', green: 'top', yellow: 'bot', blue: 'bot' };
  for (const color of E.COLORS) {
    const base = E.BASE[color];
    // Plain red-cloth corner: no colour block — carries only an embroidered
    // rosette + a small dye label so you can tell whose corner it is.
    const d = el('div', { class: 'base ' + cornerOf[color], style: `grid-column:${base.c + 1} / span 6;grid-row:${base.r + 1} / span 6;--pc:${COLVAR[color]};` });
    d.append(el('div', { class: 'bname' }, el('span', { class: 'bdot' }), color[0].toUpperCase() + color.slice(1)));
    d.append(el('div', { class: 'yard' }));
    // Four recessed token seats in a tidy 2×2, positioned from the SAME YARD
    // coords the tokens use — so each token sits centred in its socket.
    for (const [gr, gc] of E.YARD[color]) {
      const lx = (gc + 0.5 - base.c) / 6 * 100;
      const ly = (gr + 0.5 - base.r) / 6 * 100;
      d.append(el('div', { class: 'seat', style: `left:${lx}%;top:${ly}%;--sc:${COLVAR[color]}` }));
    }
    b.append(d);
  }
  // charkoni — an embroidered central medallion: four muted-dye petals stitched
  // around a brass boss where finished pieces rest. var() keeps it theme-reactive.
  const ctr = el('div', { class: 'center', style: 'grid-column:7 / span 3;grid-row:7 / span 3;' });
  ctr.style.background =
    'repeating-conic-gradient(from 0deg at 50% 50%, rgba(0,0,0,.05) 0 4deg, rgba(255,246,224,.045) 4deg 8deg),' +
    'conic-gradient(from 135deg, var(--grn) 0 90deg, var(--red) 90deg 180deg, var(--blue) 180deg 270deg, var(--yel) 270deg 360deg)';
  ctr.append(el('div', { class: 'charkoni' }));
  b.append(ctr);
  // home-run coloring + start + star + arrows
  const homeColor = {}; for (const c of E.COLORS) for (let k = 0; k < 5; k++) homeColor[E.HOME[c][k].join(',')] = c;
  const startCell = {}; for (const c of E.COLORS) startCell[E.RING[E.START_IX[c]].join(',')] = c;
  const starIx = [8, 21, 34, 47];
  const starCell = {}; for (const ix of starIx) starCell[E.RING[ix].join(',')] = 1;
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const inCross = (r >= 6 && r <= 8) || (c >= 6 && c <= 8);
    const inCenter = (r >= 6 && r <= 8) && (c >= 6 && c <= 8);
    if (!inCross || inCenter) continue;
    const cell = el('div', { class: 'cell track', style: `grid-column:${c + 1};grid-row:${r + 1};` });
    const key = r + ',' + c;
    // Home path = the player's muted dye woven as an embroidered strip on the
    // cream cross; start & safe squares carry a stitched ★ marker.
    if (homeColor[key]) { cell.classList.add('home'); cell.style.setProperty('--hc', COLVAR[homeColor[key]]); }
    if (startCell[key]) { cell.classList.add('start'); cell.style.setProperty('--hc', COLVAR[startCell[key]]); cell.append(el('div', { class: 'star start' }, '★')); }
    else if (starCell[key]) cell.append(el('div', { class: 'star' }, '★'));
    b.append(cell);
  }
  return b;
}
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n) || '#888'; }

function updateGame() {
  if (rollAnim) { pendingUpdate = true; return; } // a die is mid-tumble — don't rebuild trays
  const s = S(); if (!s || (s.phase !== 'playing' && s.phase !== 'over')) return;
  const me = mySeat();
  const active = s.turn ? s.turn.activeSeat : -1;
  const byColor = {}; for (const p of s.players) byColor[p.color] = p;
  // trays: red=TL, green=TR (top row); blue=BL, yellow=BR (bottom row)
  const top = $('#traytop'), bot = $('#traybot');
  if (top && bot) {
    top.replaceChildren(trayFor(byColor.red, 'red', false), byColor.green ? trayFor(byColor.green, 'green', true) : spacer());
    bot.replaceChildren(byColor.blue ? trayFor(byColor.blue, 'blue', false) : spacer(), byColor.yellow ? trayFor(byColor.yellow, 'yellow', true) : spacer());
  }
  if (busyAnim > 0) pendingUpdate = true; else updateTokens(); // hold token snap until hops finish
  // action hint
  const abar = $('#abar');
  if (abar) {
    abar.replaceChildren();
    if (s.phase === 'playing') {
      const p = s.players[active];
      if (active === me) {
        if (s.turn.phase === 'roll') abar.append(el('div', { class: 'abtn g', style: 'pointer-events:none' }, 'Tap the glowing die to roll ↑'));
        else if (s.turn.phase === 'move') abar.append(el('div', { class: 'abtn g', style: 'pointer-events:none' }, s.turn.movable.length === 1 ? `You rolled ${s.turn.die} — moving…` : `You rolled ${s.turn.die} — tap a highlighted token`));
        else abar.append(el('div', { class: 'abtn g', style: 'pointer-events:none' }, '…'));
      } else {
        abar.append(el('div', { class: 'abtn g', style: 'pointer-events:none' }, `${p ? p.name : '…'}'s turn`));
      }
    }
  }
  // auto-move: only one legal token → play it without asking (once per roll)
  if (busyAnim === 0 && s.phase === 'playing' && active === me && s.turn.phase === 'move' && s.turn.movable.length === 1) {
    const key = active + ':' + s.turn.die + ':' + s.turn.movable[0];
    if (ui.autoKey !== key) {
      ui.autoKey = key;
      const only = s.turn.movable[0];
      setTimeout(() => { const cur = S(); if (cur && cur.turn && cur.turn.activeSeat === me && cur.turn.phase === 'move' && cur.turn.movable.length === 1 && cur.turn.movable[0] === only) send({ type: 'move', token: only }); }, 300);
    }
  } else if (!(s.turn && s.turn.phase === 'move')) { ui.autoKey = null; }
  refreshRail();
  updateClock();
}
function spacer() { return el('div', { style: 'flex:1' }); }

function trayFor(p, color, right) {
  const s = S(); const me = mySeat(); const active = s.turn ? s.turn.activeSeat : -1;
  const isActive = p.seat === active && s.phase === 'playing';
  const mine = p.seat === me;
  const t = el('div', { class: 'tray' + (right ? ' right' : '') + (isActive ? ' active' : '') + (isActive && mine ? ' mine' : ''), style: `--pc:${COLVAR[color]}` });
  t.append(el('span', { class: 'pin' }));
  // die: active tray shows the rolled value (or an idle die inviting a tap); others faded
  let die;
  if (isActive) {
    const val = s.turn.die || 0;
    die = makeDie(val > 0 ? val : 6);
    die.id = 'activedie';
    if (val === 0) die.classList.add('idle');
    if (s.turn.phase === 'roll' && mine) { die.classList.add('rollable'); die.addEventListener('click', doRoll); t.append(el('span', { class: 'taplbl' }, 'TAP TO ROLL')); }
  } else {
    die = makeDie(6); die.classList.add('faded');
  }
  t.append(die);
  t.append(el('span', { class: 'nm' }, (p.isBot ? '🤖 ' : '') + (mine ? 'You' : p.name)));
  return t;
}

function doRoll() {
  const s = S(); const me = mySeat();
  if (!s || s.turn.activeSeat !== me || s.turn.phase !== 'roll') return;
  send({ type: 'roll' }); // the 'roll' event drives the tumble animation + sound
}

// token overlay — reconciled so CSS transitions animate position changes.
function updateTokens() {
  const s = S(); const layer = $('#tokens'); if (!layer) return;
  const me = mySeat();
  const active = s.turn ? s.turn.activeSeat : -1;
  const movable = (s.phase === 'playing' && s.turn.phase === 'move' && active === me) ? new Set(s.turn.movable) : new Set();
  // compute occupancy for stacking offset
  const cells = {};
  const placed = [];
  for (const p of s.players) {
    for (let i = 0; i < 4; i++) {
      const cell = E.cellOf(p.color, p.tokens[i], i);
      const key = Math.round(cell.rc[0]) + ',' + Math.round(cell.rc[1]) + ',' + cell.kind;
      const idx = cells[key] = (cells[key] || 0);
      cells[key] = idx + 1;
      placed.push({ p, i, cell, key, stackIdx: idx });
    }
  }
  const seen = new Set();
  for (const it of placed) {
    const id = it.p.seat + '-' + it.i; seen.add(id);
    let g = gotiEls[id];
    if (!g) { g = el('div', { class: 'goti' }); layer.append(g); gotiEls[id] = g; }
    g.style.setProperty('--gc', COLVAR[it.p.color]);
    // stacking offset when >1 in a ring/home cell
    const count = cells[it.key];
    let dx = 0, dy = 0;
    if (count > 1 && it.cell.kind !== 'yard') { const ang = (it.stackIdx / count) * Math.PI * 2; dx = Math.cos(ang) * 1.1; dy = Math.sin(ang) * 1.1; }
    const leftPct = (it.cell.rc[1] + 0.5) / 15 * 100 + dx;
    const topPct = (it.cell.rc[0] + 0.5) / 15 * 100 + dy;
    g.style.left = leftPct + '%'; g.style.top = topPct + '%';
    const canMove = movable.has(it.i) && it.p.seat === me;
    g.classList.toggle('movable', canMove);
    g.onclick = canMove ? () => { snd.move(); send({ type: 'move', token: it.i }); } : null;
  }
  for (const id of Object.keys(gotiEls)) { if (!seen.has(id)) { gotiEls[id].remove(); delete gotiEls[id]; } }
}

function updateClock() {
  const s = S(); const pill = $('#turnpill'); if (!s || !pill) return;
  if (s.phase === 'over') { pill.textContent = 'GAME OVER'; return; }
  const me = mySeat(); const active = s.turn ? s.turn.activeSeat : -1;
  let txt;
  if (active === me) { txt = s.turn.phase === 'roll' ? 'YOUR TURN · ROLL' : 'YOUR TURN · MOVE'; pill.classList.add('hot'); }
  else { const p = s.players[active]; txt = p ? `${p.name.toUpperCase()}'S TURN` : '…'; pill.classList.remove('hot'); }
  if (s.config && s.config.timed && s.turn && s.turn.deadline && s.phase === 'playing' && s.turn.phase !== 'pass') {
    const drift = s.now ? Date.now() - s.now : 0;
    const left = Math.max(0, Math.ceil((s.turn.deadline - (Date.now() - drift)) / 1000));
    txt += ` · ${left}s`;
  }
  pill.textContent = txt;
}

/* ============ events → fx ============ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busyAnim = 0;
function pctLeft(c) { return (c + 0.5) / 15 * 100 + '%'; }
function pctTop(r) { return (r + 0.5) / 15 * 100 + '%'; }

// Token hops cell-by-cell along its path from `from` to `to`.
async function hopAnim(seat, token, from, to) {
  const s = S(); const p = s.players[seat]; const id = seat + '-' + token; const g = gotiEls[id];
  if (!animOn() || !g) return;
  busyAnim++;
  const steps = [];
  for (let pos = from + 1; pos <= to; pos++) steps.push(E.cellOf(p.color, pos, token));
  g.style.zIndex = 6;
  for (const cell of steps) {
    g.style.transition = 'left .085s linear, top .085s linear, transform .085s ease-out';
    g.style.left = pctLeft(cell.rc[1]); g.style.top = pctTop(cell.rc[0]);
    g.style.transform = 'translate(-50%,-50%) translateY(-26%) scale(1.06)';
    await sleep(85);
    g.style.transform = 'translate(-50%,-50%)';
    beep(520, .025, 'sine', .02);
    await sleep(45);
  }
  g.style.zIndex = ''; g.style.transition = '';
  busyAnim--;
  if (busyAnim === 0 && !rollAnim && pendingUpdate) { pendingUpdate = false; updateGame(); }
  else if (busyAnim === 0 && !rollAnim) updateGame();
}

function onEvent(e) {
  const s = S(); if (!s) return;
  switch (e.t) {
    case 'roll': {
      animateRoll(e.seat, e.die);
      const p = s.players[e.seat];
      if (e.forfeit) toast(`${e.seat === mySeat() ? 'You' : (p ? p.name : '')} rolled three 6s — turn skipped`);
      break;
    }
    case 'move': hopAnim(e.seat, e.token, e.from, e.to); break;
    case 'capture': {
      snd.capture();
      const by = s.players[e.by], vic = s.players[e.victim];
      const g = gotiEls[e.victim + '-' + e.token];
      if (g && animOn()) { const cell = E.cellOf(vic.color, 0, e.token); g.style.transition = 'left .32s ease, top .32s ease'; g.style.left = pctLeft(cell.rc[1]); g.style.top = pctTop(cell.rc[0]); setTimeout(() => { g.style.transition = ''; }, 340); }
      toast(`${by ? by.name : '?'} sent ${vic && vic.seat === mySeat() ? 'your' : (vic ? vic.name + "'s" : 'a')} token home 🎯`);
      break;
    }
    case 'home': snd.home(); toast(`${e.seat === mySeat() ? 'You' : s.players[e.seat].name} brought a token home 🏠`); break;
    case 'turn': snd.turn(); break;
    default: break;
  }
}

/* ============ chat ============ */
// Full rail (re)build — only on first render or a tab switch (rebuilds the
// composer, so never call this on a routine state update or it wipes typing).
function renderRail() {
  const rail = $('#rail'); if (!rail) return;
  const chatTab = () => { ui.chatTab = 'chat'; ui.chatUnread = false; renderRail(); };
  const chatBtn = el('button', { class: ui.chatTab === 'chat' ? 'on' : '', onclick: chatTab }, 'CHAT');
  if (ui.chatUnread && ui.chatTab !== 'chat') chatBtn.append(el('span', { class: 'unread' }, '●'));
  rail.dataset.tab = ui.chatTab;
  rail.replaceChildren(...[
    el('div', { class: 'tabs' }, el('button', { class: ui.chatTab === 'log' ? 'on' : '', onclick: () => { ui.chatTab = 'log'; renderRail(); } }, 'ACTIVITY'), chatBtn),
    el('div', { class: 'feed', id: 'railfeed' }),
    ui.chatTab === 'chat' ? chatComposer() : null,
  ].filter(Boolean));
  fillFeed();
}
// Light refresh — updates only the feed content, leaving the composer (and any
// in-progress typing + focus) untouched. Used on every state update.
function refreshRail() {
  const rail = $('#rail'); if (!rail) return;
  if (!$('#railfeed') || rail.dataset.tab !== ui.chatTab) { renderRail(); return; }
  fillFeed();
}
function fillFeed() {
  const feed = $('#railfeed'); if (!feed) return;
  const s = S();
  feed.replaceChildren();
  if (ui.chatTab === 'log') for (const line of (s.log || [])) feed.append(el('div', {}, line));
  else for (const m of (s.chat || [])) feed.append(el('div', {}, el('b', {}, m.name + ': '), m.text));
  feed.scrollTop = feed.scrollHeight;
}
function chatComposer() {
  const input = el('input', { placeholder: 'Say something…', maxlength: 200 });
  const sendIt = () => { const v = input.value.trim(); if (!v) return; send({ type: 'chat', text: v }); input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendIt(); });
  return el('div', { class: 'chatin' }, input, el('button', { onclick: sendIt }, '➤'));
}
function openChatSheet() {
  ui.chatOpen = true; ui.unread = 0; updateFab();
  const s = S(); const feed = el('div', { class: 'feed' });
  for (const m of (s.chat || [])) feed.append(el('div', {}, el('b', {}, m.name + ': '), m.text));
  const emos = el('div', { class: 'emorow' }); for (const e of ['👍', '😂', '😮', '😤', '🎉']) emos.append(el('button', { onclick: () => send({ type: 'chat', text: e }) }, e));
  openSheet(el('div', {}, el('div', { class: 't' }, 'BOARD CHAT'), el('div', { class: 'chatsheet' }, feed), emos, chatComposer(), el('button', { class: 'btn q', style: 'margin-top:8px;', onclick: () => { ui.chatOpen = false; closeOverlays(); } }, 'Close')));
  feed.scrollTop = feed.scrollHeight;
}
function updateFab() { const fab = $('#chatfab'); if (!fab) return; const old = fab.querySelector('.badge'); if (old) old.remove(); if (ui.unread > 0) fab.append(el('span', { class: 'badge' }, String(ui.unread))); }
const isEmoji = (t) => t.length <= 4 && !/[a-z0-9]/i.test(t);
function onChat(m) {
  const s = S(); if (s) { (s.chat = s.chat || []).push(m); if (s.chat.length > 50) s.chat.shift(); }
  if (isDesktop()) {
    if (ui.chatTab === 'chat') refreshRail();       // preserve the composer while typing
    else { ui.chatUnread = true; renderRail(); }     // on Activity tab: safe to rebuild + flag
    return;
  }
  if (ui.chatOpen && $('.chatsheet')) { const feed = $('.chatsheet .feed'); if (feed) { feed.append(el('div', {}, el('b', {}, m.name + ': '), m.text)); feed.scrollTop = feed.scrollHeight; } return; }
  if (m.seat !== mySeat()) { ui.unread++; updateFab(); }
  flyChat(m);
}
function flyChat(m) {
  if (!animOn() || document.querySelectorAll('.flymsg,.flyemo').length >= 2) return;
  if ($('.modal') || $('.sheet')) return;
  const W = innerWidth, H = innerHeight;
  if (isEmoji(m.text)) {
    const n = el('div', { class: 'flyemo', style: `left:${20 + Math.random() * (W - 80)}px;top:${H - 180}px;` }, m.text);
    document.body.append(n);
    n.animate([{ transform: 'translateY(0) scale(.8)', opacity: 0 }, { transform: `translateY(-${H * 0.4}px) scale(1.25)`, opacity: 1, offset: .5 }, { transform: `translateY(-${H * 0.7}px) scale(1)`, opacity: 0 }], { duration: 2600, easing: 'ease-out' });
    setTimeout(() => n.remove(), 2600);
  } else {
    const clip = m.text.length > 60 ? m.text.slice(0, 57) + '…' : m.text;
    const n = el('div', { class: 'flymsg', style: `left:${14 + Math.random() * Math.max(40, W * 0.3)}px;top:${H * 0.42}px;`, onclick: openChatSheet }, el('b', {}, m.name + ': '), clip);
    document.body.append(n);
    n.animate([{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1, offset: .15 }, { transform: 'translateY(-46px)', opacity: 1, offset: .8 }, { transform: 'translateY(-70px)', opacity: 0 }], { duration: 2850, easing: 'ease-out' });
    setTimeout(() => n.remove(), 2850);
  }
}

/* ============ menu / overlays ============ */
function openMenu() {
  const s = S(); const me = mySeat(); const isHost = s && (net ? me === s.host : true);
  const items = el('div', { class: 'choice' });
  if (s && s.phase === 'playing' && !local && net && net.seat === s.host) items.append(el('button', { class: 'c', onclick: () => { closeOverlays(); send({ type: 'wrapup' }); } }, '🏁 Wrap up game', el('small', { style: 'margin-left:auto;color:var(--tx2)' }, 'rank now')));
  items.append(
    el('button', { class: 'c', onclick: () => { closeOverlays(); openHowtoSheet(); } }, '📖 How to play'),
    el('button', { class: 'c', onclick: () => { closeOverlays(); const v = soundOn() ? '0' : '1'; store.set('lu_sound', v); toast(v === '1' ? 'Sound on' : 'Sound muted'); } }, soundOn() ? '🔇 Mute sound' : '🔊 Unmute sound'),
    el('button', { class: 'c', onclick: () => { closeOverlays(); leaveToHome(); } }, '🚪 Leave board'));
  openSheet(el('div', {}, el('div', { class: 't' }, 'MENU'), items, el('button', { class: 'btn q', onclick: closeOverlays }, 'Close')));
}
function openSheet(content) { closeOverlays(); const dim = el('div', { class: 'dim', onclick: closeOverlays }); const sh = el('div', { class: 'sheet' }, content); document.body.append(dim, sh); }
function openModal(content, sticky) { closeOverlays(); const dim = el('div', { class: 'dim', onclick: sticky ? null : closeOverlays }); const md = el('div', { class: 'modal' }, content); document.body.append(dim, md); }
function toast(msg) { const old = $('.toast'); if (old) old.remove(); const t = el('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2200); }

/* ============ game over ============ */
function showGameOver() {
  const s = S(); if (!s || s.phase !== 'over' || overShown) return; overShown = true;
  const standings = s.standings || [];
  const medals = ['🥇', '🥈', '🥉'];
  const rows = el('div', { style: 'display:flex;flex-direction:column;gap:7px;width:100%;' });
  standings.forEach((r, i) => rows.append(el('div', { class: 'standrow' }, el('span', { class: 'dot', style: 'width:16px;height:16px;border-radius:50%;background:' + COLVAR[r.color] }), `${medals[i] || (i + 1) + ' ·'} ${r.seat === mySeat() ? 'You' : r.name}`, el('span', { class: 'ct' }, `${r.home}/4 home`))));
  const winner = standings[0];
  const isHost = net ? mySeat() === s.host : true;
  openModal(el('div', {},
    el('div', { class: 'cup' }, '🏆'),
    el('div', { class: 'win-name' }, winner ? (winner.seat === mySeat() ? 'YOU WIN' : winner.name.toUpperCase() + ' WINS') : 'GAME OVER'),
    el('div', { class: 'win-sub' }, 'all four gotis home'),
    el('div', { style: 'height:12px;' }), rows, el('div', { style: 'height:12px;' }),
    (local || isHost) ? el('button', { class: 'btn p', onclick: () => { overShown = false; closeOverlays(); local ? localRematch() : send({ type: 'rematch' }); } }, 'REMATCH') : null,
    el('button', { class: 'btn q', onclick: () => { overShown = false; leaveToHome(); } }, 'BACK HOME')), true);
}

/* ============ PASS & PLAY ============ */
function renderPassSetup() {
  let humans = 2, bots = 0;
  const seg = (opts, cur, onpick) => { const w = el('div', { class: 'seg' }); for (const o of opts) w.append(el('button', { class: 's' + (o.v === cur ? ' on' : ''), onclick: () => { onpick(o.v); [...w.children].forEach((c, i) => c.classList.toggle('on', opts[i].v === o.v)); } }, o.l)); return w; };
  const names = []; const colors = ['red', 'green', 'yellow', 'blue']; const nameWrap = el('div', {});
  const rebuild = () => {
    nameWrap.replaceChildren();
    for (let i = 0; i < humans; i++) {
      const inp = el('input', { class: 'f-in', maxlength: 16, placeholder: `Player ${i + 1}`, value: names[i] || (i === 0 ? store.get('lu_name', '') : '') });
      inp.addEventListener('input', () => names[i] = inp.value); names[i] = inp.value;
      const sws = el('div', { style: 'display:flex;gap:8px;margin:6px 0 12px;' });
      for (const c of ['red', 'green', 'yellow', 'blue']) {
        const taken = colors.slice(0, humans).some((cc, j) => j !== i && cc === c);
        const sw = el('button', { class: 'colorsw' + (colors[i] === c ? ' mine' : '') + (taken ? ' taken' : ''), style: `--pc:${COLVAR[c]};width:28px;height:28px;font-size:11px;`, onclick: () => { if (!taken) { colors[i] = c; rebuild(); } } });
        sws.append(sw);
      }
      nameWrap.append(inp, sws);
    }
  };
  rebuild();
  const err = el('div', { class: 'err' });
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('button', { class: 'iconbtn', onclick: () => go(renderHome) }, '✕')),
    el('div', { class: 'title' }, 'PASS & PLAY'),
    el('div', { class: 'f-lab' }, 'Humans on this phone'), seg([1, 2, 3, 4].map((n) => ({ v: n, l: String(n) })), humans, (v) => { humans = v; rebuild(); }),
    el('div', { class: 'f-lab' }, 'Bots'), seg([0, 1, 2, 3].map((n) => ({ v: n, l: String(n) })), bots, (v) => bots = v),
    el('div', { class: 'f-lab' }, 'Names'), nameWrap, err,
    el('div', { style: 'margin-top:auto;' }, el('button', { class: 'btn p', onclick: () => {
      if (humans + bots < 2) { err.textContent = 'Need at least 2 players.'; return; }
      if (humans + bots > 4) { err.textContent = 'Max 4 players.'; return; }
      startLocal(names.slice(0, humans).map((n, i) => (n || '').trim() || `Player ${i + 1}`), bots, colors.slice(0, humans));
    } }, 'START GAME'))));
}
function startLocal(humanNames, botCount, humanColors) {
  const g = { code: 'LOCAL', phase: 'lobby', visibility: 'local', capacity: humanNames.length + botCount, host: 0, players: [], turn: null, ranking: [], winner: null, log: [], chat: [], config: { timed: false, turnSeconds: 0 }, rngSeed: (Math.floor(Math.random() * 0x7fffffff) | 0) || 1 };
  humanNames.forEach((n, i) => { const p = E.newPlayer(i, n, false); p.connected = true; if (humanColors && humanColors[i]) p.pref = humanColors[i]; g.players.push(p); });
  for (let b = 0; b < botCount; b++) g.players.push(E.newPlayer(humanNames.length + b, `Baron Bot ${b + 1}`, true));
  E.startGame(g);
  net = null; local = { g, humans: humanNames.length, botTimer: null }; overShown = false;
  go(renderGame);
  scheduleLocalBot();
  saveLocal();
}
function localSend(msg) {
  const g = local.g; const seat = g.turn.activeSeat;
  if (g.players[seat].isBot) return; // ignore stray input during bot turn
  if (msg.type === 'roll') { doLocalRoll(seat); return; }
  if (msg.type === 'move') { doLocalMove(seat, msg.token); return; }
  if (msg.type === 'chat') return; // no chat in pass&play
  if (msg.type === 'wrapup') { g.standings = E.standings(g); g.phase = 'over'; clearLocal(); updateGame(); showGameOver(); return; }
}
function doLocalRoll(seat) {
  const g = local.g;
  if (g.turn.phase !== 'roll') return;
  const r = E.roll(g, seat);
  onEvent({ t: 'roll', seat, die: r.die, forfeit: !!r.forfeit });
  if (r.forfeit || r.noMove) { setTimeout(() => { E.nextTurn(g); onEvent({ t: 'turn', seat: g.turn.activeSeat }); updateGame(); scheduleLocalBot(); saveLocal(); }, 1000); }
  updateGame();
  saveLocal();
}
function doLocalMove(seat, token) {
  const g = local.g;
  if (g.turn.phase !== 'move') return;
  const res = E.applyMove(g, seat, token);
  if (!res.ok) return;
  for (const e of res.events) onEvent(e);
  updateGame();
  const over = E.checkWin(g);
  if (over) { g.standings = over; clearLocal(); setTimeout(() => { updateGame(); showGameOver(); }, 400); return; }
  if (res.bonus) { g.turn.phase = 'roll'; g.turn.die = 0; g.turn.movable = []; g.turn.moved = false; }
  else { E.nextTurn(g); onEvent({ t: 'turn', seat: g.turn.activeSeat }); }
  updateGame();
  scheduleLocalBot();
  saveLocal();
}
function scheduleLocalBot() {
  const g = local.g; if (!local || g.phase !== 'playing') return;
  if (local.botTimer) clearTimeout(local.botTimer);
  const p = g.players[g.turn.activeSeat];
  if (!p.isBot) return;
  local.botTimer = setTimeout(() => {
    if (!local || g.phase !== 'playing') return;
    const seat = g.turn.activeSeat;
    if (g.turn.phase === 'roll') doLocalRoll(seat);
    else if (g.turn.phase === 'move') doLocalMove(seat, E.botPick(g, seat));
  }, 800);
}
function localRematch() {
  const g = local.g; g.rngSeed = (g.rngSeed + 0x9e3779b9) | 0 || 1; delete g.standings;
  E.startGame(g); overShown = false; go(renderGame); scheduleLocalBot(); saveLocal();
}

// Pass & play has no server, so persist the game locally and resume it on refresh.
function saveLocal() {
  try { if (local && local.g && local.g.phase === 'playing') store.set('lu_local', JSON.stringify({ g: local.g, humans: local.humans })); }
  catch { /* storage full / private mode */ }
}
function clearLocal() { store.del('lu_local'); }
function restoreLocal() {
  let saved = null;
  try { saved = JSON.parse(store.get('lu_local', '') || 'null'); } catch { saved = null; }
  if (!saved || !saved.g || saved.g.phase !== 'playing') { clearLocal(); return false; }
  net = null;
  local = { g: saved.g, humans: saved.humans || saved.g.players.filter((p) => !p.isBot).length, botTimer: null };
  overShown = false;
  go(renderGame); scheduleLocalBot();
  return true;
}

/* ============ HOW TO / SETTINGS ============ */
function howtoContent() {
  return el('div', { class: 'how' },
    el('div', { class: 'hcard' }, el('h3', {}, '🎯 THE GOAL'), el('p', {}, 'Race all ', el('b', {}, 'four gotis'), ' from your yard, once around the cloth, and up your colour lane into the centre. First to bring all four home wins.')),
    el('div', { class: 'hcard' }, el('h3', {}, '🎲 YOUR TURN'), el('ul', {}, el('li', {}, 'When the turn reaches you, your corner tray glows — ', el('b', {}, 'tap the die to roll.')), el('li', {}, 'You need a ', el('b', {}, '6'), ' to bring a goti out of the yard.'), el('li', {}, 'Roll a ', el('b', {}, '6, capture, or send one home'), ' → throw again. Three 6s in a row skips your turn.'))),
    el('div', { class: 'hcard' }, el('h3', {}, '🎯 CAPTURE & CASTLES'), el('p', {}, 'Land exactly on a rival and it goes ', el('b', {}, 'back to their yard'), '. The ', el('b', {}, '★ star squares'), ' are safe — no capture there. You need the ', el('b', {}, 'exact roll'), ' to reach the centre.')),
    el('div', { class: 'hcard' }, el('h3', {}, '🤝 PLAY ANYWHERE'), el('p', {}, 'Online with friends (share the code), against bots, or pass one phone around the table.')));
}
function renderHowto() { app.append(el('div', { class: 'screen' }, el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('button', { class: 'iconbtn', onclick: () => go(renderHome) }, '✕')), el('div', { class: 'title' }, 'HOW TO PLAY'), howtoContent())); }
function openHowtoSheet() { openSheet(el('div', {}, el('div', { class: 't' }, 'HOW TO PLAY'), howtoContent(), el('button', { class: 'btn q', onclick: closeOverlays }, 'Close'))); }
function renderSettings() {
  const nameIn = el('input', { class: 'f-in', maxlength: 20, value: store.get('lu_name', ''), placeholder: 'Your name' });
  nameIn.addEventListener('change', () => store.set('lu_name', nameIn.value.trim()));
  const seg = (opts, cur, onpick) => { const w = el('div', { class: 'seg' }); for (const o of opts) w.append(el('button', { class: 's' + (o.v === cur ? ' on' : ''), onclick: () => { onpick(o.v); [...w.children].forEach((c, i) => c.classList.toggle('on', opts[i].v === o.v)); } }, o.l)); return w; };
  app.append(el('div', { class: 'screen' },
    el('div', { class: 'bar' }, el('span', { class: 'logo' }, 'PACHISI'), el('span', { class: 'spacer' }), el('button', { class: 'iconbtn', onclick: () => go(renderHome) }, '✕')),
    el('div', { class: 'title' }, 'SETTINGS'),
    el('div', { class: 'f-lab' }, 'Name'), nameIn,
    el('div', { class: 'f-lab' }, 'Theme'), seg([{ v: 'system', l: 'System' }, { v: 'light', l: '☀ Day' }, { v: 'dark', l: '☾ Night' }], store.get('lu_theme', 'system'), (v) => { store.set('lu_theme', v); applyTheme(); }),
    el('div', { class: 'f-lab' }, 'Sound'), seg([{ v: '1', l: 'On' }, { v: '0', l: 'Muted' }], store.get('lu_sound', '1'), (v) => store.set('lu_sound', v)),
    el('div', { class: 'f-lab' }, 'Animations'), seg([{ v: '1', l: 'On' }, { v: '0', l: 'Off' }], store.get('lu_anim', '1'), (v) => store.set('lu_anim', v)),
    el('div', { class: 'foot-c' }, '© AGAPPS')));
}
