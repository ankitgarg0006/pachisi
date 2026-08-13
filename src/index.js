// src/index.js — Worker entry for Chausar.
// JSON HTTP API under /api (create/list/inspect boards + WS upgrade). Everything
// else serves the static-assets PWA. © agapps

import { LudoRoom } from './room.js';
import { Lobby } from './lobby.js';

export { LudoRoom, Lobby };

const CODE_RE = /^\d{6}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, path);
      } catch (err) {
        return json({ error: 'server-error', msg: String(err && err.message) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

function lobbyStub(env) {
  return env.LOBBY.get(env.LOBBY.idFromName('global'));
}
function roomStub(env, code) {
  return env.GAME.get(env.GAME.idFromName('room:' + code));
}

async function handleApi(request, env, url, path) {
  // POST /api/rooms — create a board.
  if (path === '/api/rooms' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { /* defaults */ }
    const seats = Math.min(4, Math.max(2, parseInt(body.seats, 10) || 4));
    const visibility = ['public', 'private', 'bots'].includes(body.visibility) ? body.visibility : 'private';
    const name = (body.name || 'Host').toString().slice(0, 24);
    const timed = !!body.timed;
    const turnSeconds = timed ? Math.max(15, Math.min(300, parseInt(body.turnSeconds, 10) || 45)) : 0;

    const alloc = await lobbyStub(env).fetch('https://lobby/allocate', {
      method: 'POST',
      body: JSON.stringify({ seats, visibility, host: name }),
    });
    const allocJson = await alloc.json();
    if (!alloc.ok || !allocJson.code) return json({ error: 'no-codes' }, 503);
    const code = allocJson.code;

    const initRes = await roomStub(env, code).fetch('https://room/init', {
      method: 'POST',
      headers: { 'x-lud-op': 'init' },
      body: JSON.stringify({ code, seats, visibility, name, timed, turnSeconds }),
    });
    const initJson = await initRes.json();
    return json({ code, token: initJson.token, seat: initJson.seat });
  }

  // GET /api/rooms — public boards waiting for players.
  if (path === '/api/rooms' && request.method === 'GET') {
    const res = await lobbyStub(env).fetch('https://lobby/list');
    return json(await res.json());
  }

  // /api/rooms/:code and /api/rooms/:code/ws
  const m = path.match(/^\/api\/rooms\/(\d{6})(\/ws)?$/);
  if (m) {
    const code = m[1];
    if (m[2]) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected-websocket' }, 426);
      }
      return roomStub(env, code).fetch(request);
    }
    if (request.method === 'GET') {
      if (!CODE_RE.test(code)) return json({ exists: false });
      const res = await roomStub(env, code).fetch('https://room/info', { headers: { 'x-lud-op': 'info' } });
      return json(await res.json());
    }
  }

  return json({ error: 'not-found' }, 404);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
