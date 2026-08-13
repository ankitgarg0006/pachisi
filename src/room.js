// src/room.js — LudoRoom Durable Object (one per board, "room:" + code).
// Owns the authoritative game state, drives bots / turn timers / pass delays via
// a single DO alarm, and speaks the WS protocol with hibernation. Rules live in
// public/engine.js (shared with the pass-and-play client). © agapps

import { DurableObject } from 'cloudflare:workers';
import * as E from '../public/engine.js';

const STAGGER = 800;      // ms between visible bot actions (roll, then move)
const PASS_MS = 1100;     // how long a "no move / forfeit" roll stays on screen
const EMPTY_GRACE = 30000;

export class LudoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.game = null;
  }

  async #load() { if (!this.game) this.game = await this.ctx.storage.get('state'); return this.game; }
  async #save() { await this.ctx.storage.put('state', this.game); }

  // ===================== HTTP =====================
  async fetch(request) {
    const url = new URL(request.url);
    const op = request.headers.get('x-lud-op');
    if (op === 'init') return this.#init(await request.json());
    if (op === 'info') {
      const g = await this.#load();
      if (!g) return json({ exists: false });
      return json({ exists: true, phase: g.phase, players: g.players.length, capacity: g.capacity });
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const g = await this.#load();
      const token = url.searchParams.get('token') || null;
      const name = url.searchParams.get('name') || 'Player';
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ seat: null, token, name });
      if (!g) { this.#send(server, { type: 'error', code: 'no-room', msg: 'Board not found.' }); server.close(1011, 'no-room'); }
      else if (token) await this.#reconnect(server, token);
      else if (g.phase !== 'lobby') { this.#send(server, { type: 'error', code: 'in-progress', msg: 'Game already started.' }); server.close(1000, 'in-progress'); }
      else await this.#join(server, name);
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'bad-request' }, 400);
  }

  async #init(body) {
    const capacity = Math.min(4, Math.max(2, body.seats || 4));
    const visibility = ['public', 'private', 'bots'].includes(body.visibility) ? body.visibility : 'private';
    const timed = !!body.timed;
    const turnSeconds = timed ? Math.max(15, Math.min(300, parseInt(body.turnSeconds, 10) || 45)) : 0;
    const g = {
      code: body.code, phase: 'lobby',
      visibility: visibility === 'bots' ? 'private' : visibility,
      capacity, config: { timed, turnSeconds },
      players: [], host: 0, autostart: visibility === 'bots',
      turn: null, ranking: [], winner: null,
      log: ['Board opened.'], chat: [],
      rngSeed: (Math.floor(Math.random() * 0x7fffffff) | 0) || 1,
    };
    const hostToken = crypto.randomUUID();
    const host = E.newPlayer(0, (body.name || 'Host').slice(0, 24), false);
    host.token = hostToken;
    g.players.push(host);
    if (visibility === 'bots') {
      while (g.players.length < capacity) {
        const seat = g.players.length;
        const b = E.newPlayer(seat, `Baron Bot ${seat}`, true);
        b.token = crypto.randomUUID();
        g.players.push(b);
      }
    }
    g.emptySince = Date.now();
    this.game = g;
    await this.#save();
    await this.#syncLobby();
    this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE);
    return json({ code: g.code, token: hostToken, seat: 0 });
  }

  // ===================== WS =====================
  async webSocketMessage(ws, raw) {
    const g = await this.#load();
    if (!g) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const seat = att.seat;
    switch (msg.type) {
      case 'join': if (seat == null) await this.#join(ws, msg.name || att.name || 'Player'); break;
      case 'reconnect': await this.#reconnect(ws, msg.token || att.token); break;
      case 'ready': await this.#setReady(seat, !!msg.ready); break;
      case 'pickColor': await this.#pickColor(seat, msg.color); break;
      case 'addBot': await this.#addBot(seat); break;
      case 'removeBot': await this.#removeBot(seat); break;
      case 'start': await this.#start(seat); break;
      case 'roll': await this.#humanRoll(seat); break;
      case 'move': await this.#humanMove(seat, msg.token); break;
      case 'chat': await this.#chat(seat, msg.text); break;
      case 'wrapup': await this.#wrapup(seat); break;
      case 'rematch': await this.#rematch(seat); break;
      default: break;
    }
  }

  async webSocketClose(ws) {
    const g = await this.#load();
    if (!g) return;
    const att = ws.deserializeAttachment() || {};
    if (att.seat != null) {
      const p = g.players[att.seat];
      if (p && !p.isBot) { p.connected = false; E.log(g, `${p.name} disconnected.`); }
    }
    if (this.#connectedHumans() === 0) {
      g.emptySince = Date.now();
      await this.#save();
      this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE);
      return;
    }
    await this.#save();
    this.#broadcastState();
    this.#schedule();
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  #connectedHumans() {
    const g = this.game;
    if (!g || !g.players) return 0;
    return g.players.filter((p) => !p.isBot && p.connected).length;
  }

  async #destroyRoom() {
    const code = this.game && this.game.code;
    try { await this.ctx.storage.deleteAlarm(); } catch { /* ignore */ }
    try { await this.ctx.storage.deleteAll(); } catch { /* ignore */ }
    this.game = null;
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'room-empty'); } catch { /* ignore */ } }
    if (code) {
      try { await this.env.LOBBY.get(this.env.LOBBY.idFromName('global')).fetch('https://lobby/close', { method: 'POST', body: JSON.stringify({ code }) }); } catch { /* best-effort */ }
    }
  }

  // ===================== lobby =====================
  async #join(ws, name) {
    const g = this.game;
    if (g.phase !== 'lobby') { this.#send(ws, { type: 'error', code: 'in-progress', msg: 'Game already started.' }); ws.close(1000, 'in-progress'); return; }
    if (g.players.length >= g.capacity) { this.#send(ws, { type: 'error', code: 'full', msg: 'Board is full.' }); ws.close(1000, 'full'); return; }
    const seat = g.players.length;
    const token = crypto.randomUUID();
    const p = E.newPlayer(seat, String(name).slice(0, 24), false);
    p.token = token; p.connected = true; p.ready = false;
    g.players.push(p);
    g.emptySince = 0;
    ws.serializeAttachment({ seat, token, name: p.name });
    E.log(g, `${p.name} joined.`);
    await this.#save();
    await this.#syncLobby();
    this.#welcome(ws, seat);
    this.#broadcastState();
  }

  async #reconnect(ws, token) {
    const g = this.game;
    const p = token ? g.players.find((x) => x.token === token) : null;
    if (!p) { this.#send(ws, { type: 'error', code: 'bad-token', msg: 'Seat not found.' }); ws.close(1000, 'bad-token'); return; }
    p.connected = true;
    g.emptySince = 0;
    ws.serializeAttachment({ seat: p.seat, token, name: p.name });
    if (g.phase === 'lobby' && g.autostart && p.seat === g.host) await this.#start(g.host);
    else await this.#save();
    E.log(g, `${p.name} reconnected.`);
    this.#welcome(ws, p.seat);
    this.#broadcastState();
    this.#schedule();
  }

  async #setReady(seat, ready) {
    const g = this.game;
    if (seat == null || g.phase !== 'lobby') return;
    const p = g.players[seat]; if (!p) return;
    p.ready = ready; await this.#save(); this.#broadcastState();
  }

  async #pickColor(seat, color) {
    const g = this.game;
    if (seat == null || g.phase !== 'lobby') return;
    if (!E.COLORS.includes(color)) return;
    if (g.players.some((p) => p.seat !== seat && p.pref === color)) {
      this.#sendToSeat(seat, { type: 'error', code: 'color', msg: 'That colour is taken.' });
      return;
    }
    const p = g.players[seat];
    p.pref = p.pref === color ? null : color; // tap again to release
    await this.#save();
    this.#broadcastState();
  }

  async #addBot(hostSeat) {
    const g = this.game;
    if (g.phase !== 'lobby' || hostSeat !== g.host || g.players.length >= g.capacity) return;
    const seat = g.players.length;
    const b = E.newPlayer(seat, `Baron Bot ${seat}`, true);
    b.token = crypto.randomUUID();
    g.players.push(b);
    E.log(g, `A bot sat down.`);
    await this.#save(); await this.#syncLobby(); this.#broadcastState();
  }

  async #removeBot(hostSeat) {
    const g = this.game;
    if (g.phase !== 'lobby' || hostSeat !== g.host) return;
    const last = g.players[g.players.length - 1];
    if (!last || !last.isBot) return;
    g.players.pop();
    E.log(g, 'A bot left.');
    await this.#save(); await this.#syncLobby(); this.#broadcastState();
  }

  async #start(hostSeat) {
    const g = this.game;
    if (g.phase !== 'lobby') return;
    if (hostSeat !== g.host) { this.#sendToSeat(hostSeat, { type: 'error', code: 'not-host', msg: 'Only the host can start.' }); return; }
    if (g.players.length < 2) return;
    g.autostart = false;
    E.startGame(g);
    this.#arm();
    E.log(g, 'The game has started.');
    await this.#save(); await this.#syncLobby();
    this.#broadcastState();
    this.#emit({ t: 'turn', seat: g.turn.activeSeat });
    this.#schedule();
  }

  // ===================== turn flow =====================
  #arm() {
    const g = this.game;
    g.turn.deadline = g.config.timed ? Date.now() + g.config.turnSeconds * 1000 : 0;
  }

  async #humanRoll(seat) {
    const g = this.game;
    if (g.phase !== 'playing' || g.turn.activeSeat !== seat || g.turn.phase !== 'roll') return;
    await this.#doRoll(seat);
  }

  async #humanMove(seat, token) {
    const g = this.game;
    if (g.phase !== 'playing' || g.turn.activeSeat !== seat || g.turn.phase !== 'move') return;
    if (typeof token !== 'number') return;
    await this.#doMove(seat, token);
  }

  async #doRoll(seat) {
    const g = this.game;
    const r = E.roll(g, seat);
    this.#emit({ t: 'roll', seat, die: r.die, forfeit: !!r.forfeit });
    if (r.forfeit) E.log(g, `${g.players[seat].name} rolled three 6s — turn forfeited.`);
    if (r.forfeit || r.noMove) {
      g.turn.phase = 'pass';
      g.turn.deadline = Date.now() + PASS_MS;
    } else {
      this.#arm();
    }
    await this.#save();
    this.#broadcastState();
    this.#schedule();
  }

  async #doMove(seat, token) {
    const g = this.game;
    const res = E.applyMove(g, seat, token);
    if (!res.ok) { this.#sendToSeat(seat, { type: 'error', code: 'move', msg: 'That token can’t move.' }); return; }
    for (const e of res.events) this.#emit(e);
    const over = E.checkWin(g);
    if (over) { await this.#endGame(over); return; }
    if (res.bonus) {
      g.turn.phase = 'roll'; g.turn.die = 0; g.turn.movable = []; g.turn.moved = false;
      this.#arm();
    } else {
      E.nextTurn(g);
      this.#arm();
      this.#emit({ t: 'turn', seat: g.turn.activeSeat });
    }
    await this.#save();
    this.#broadcastState();
    this.#schedule();
  }

  async #passTurn() {
    const g = this.game;
    E.nextTurn(g);
    this.#arm();
    this.#emit({ t: 'turn', seat: g.turn.activeSeat });
    await this.#save();
    this.#broadcastState();
    this.#schedule();
  }

  async #chat(seat, text) {
    const g = this.game;
    const p = seat != null && g.players[seat];
    if (!p || p.isBot || typeof text !== 'string') return;
    const clean = text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (p.lastChatAt && now - p.lastChatAt < 600) return;
    p.lastChatAt = now;
    if (!g.chat) g.chat = [];
    const msg = { seat, name: p.name, text: clean, t: now };
    g.chat.push(msg);
    if (g.chat.length > 50) g.chat.shift();
    await this.#save();
    this.#broadcast({ type: 'chat', msg });
  }

  async #wrapup(seat) {
    const g = this.game;
    if (g.phase !== 'playing') return;
    if (seat !== g.host) { this.#sendToSeat(seat, { type: 'error', code: 'not-host', msg: 'Only the host can wrap up.' }); return; }
    E.log(g, 'Host wrapped up the game.');
    await this.#endGame(E.standings(g));
  }

  async #rematch(seat) {
    const g = this.game;
    if (g.phase !== 'over' || seat !== g.host) return;
    g.rngSeed = (g.rngSeed + 0x9e3779b9) | 0 || 1;
    delete g.standings;
    E.startGame(g);
    this.#arm();
    E.log(g, 'Rematch! New game.');
    await this.#save();
    this.#broadcastState();
    this.#emit({ t: 'turn', seat: g.turn.activeSeat });
    this.#schedule();
  }

  // ===================== alarm =====================
  async alarm() {
    const g = await this.#load();
    if (!g) return;
    if (this.#connectedHumans() === 0) {
      if (g.emptySince && Date.now() - g.emptySince >= EMPTY_GRACE) { await this.#destroyRoom(); return; }
      if (!g.emptySince) g.emptySince = Date.now();
      await this.#save();
      this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE);
      return;
    }
    if (g.emptySince) { g.emptySince = 0; await this.#save(); }
    if (g.phase !== 'playing') return;
    const now = Date.now();

    if (g.turn.phase === 'pass') {
      if (now >= g.turn.deadline) { await this.#passTurn(); }
      else this.#schedule();
      return;
    }

    const active = g.players[g.turn.activeSeat];
    if (!active) return;

    if (active.isBot || !active.connected) {
      // one visible step per tick
      if (g.turn.phase === 'roll') await this.#doRoll(g.turn.activeSeat);
      else if (g.turn.phase === 'move') await this.#doMove(g.turn.activeSeat, E.botPick(g, g.turn.activeSeat));
      return;
    }
    // connected human
    if (g.config.timed && g.turn.deadline && now >= g.turn.deadline) {
      if (g.turn.phase === 'roll') await this.#doRoll(g.turn.activeSeat);
      else if (g.turn.phase === 'move') await this.#doMove(g.turn.activeSeat, E.botPick(g, g.turn.activeSeat));
      return;
    }
    this.#schedule();
  }

  #schedule() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const now = Date.now();
    let at;
    if (g.turn.phase === 'pass') at = g.turn.deadline;
    else {
      const active = g.players[g.turn.activeSeat];
      if (!active) return;
      if (active.isBot || !active.connected) at = now + STAGGER;
      else if (g.config.timed && g.turn.deadline) at = Math.max(now + 250, g.turn.deadline);
      else return; // untimed connected human — wait for their tap
    }
    this.ctx.storage.setAlarm(Math.max(now + 100, at));
  }

  // ===================== game over =====================
  async #endGame(standings) {
    const g = this.game;
    g.phase = 'over';
    g.standings = standings;
    E.log(g, 'Game over.');
    await this.#save();
    await this.ctx.storage.deleteAlarm();
    this.#broadcastState();
    this.#broadcast({ type: 'over', standings });
    try { await this.env.LOBBY.get(this.env.LOBBY.idFromName('global')).fetch('https://lobby/close', { method: 'POST', body: JSON.stringify({ code: g.code }) }); } catch { /* best-effort */ }
  }

  // ===================== messaging =====================
  #send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* gone */ } }
  #sendToSeat(seat, obj) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.seat === seat) this.#send(ws, obj);
    }
  }
  #welcome(ws, seat) {
    this.#send(ws, { type: 'welcome', you: { seat, token: this.game.players[seat].token }, state: this.#viewFor(seat) });
  }
  #broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* ignore */ } } }
  #broadcastState() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      this.#send(ws, { type: 'state', state: this.#viewFor(att.seat) });
    }
  }
  #emit(e) { this.#broadcast({ type: 'event', e }); }
  #viewFor(seat) {
    const v = E.viewFor(this.game);
    for (const p of v.players) { if (p.seat !== seat) delete p.token; delete p.lastChatAt; }
    delete v.autostart;
    v.now = Date.now();
    return v;
  }

  async #syncLobby() {
    const g = this.game;
    try {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
      await stub.fetch('https://lobby/update', {
        method: 'POST',
        body: JSON.stringify({
          code: g.code, visibility: g.visibility,
          players: g.players.length, capacity: g.capacity,
          host: g.players[0] ? g.players[0].name : '',
          phase: g.phase, full: g.players.length >= g.capacity,
        }),
      });
    } catch { /* best-effort */ }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
