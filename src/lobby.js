// src/lobby.js — Lobby Durable Object (single instance, idFromName "global").
// Allocates unique 6-digit codes and keeps the public-tables list.
// Identical pattern to Bazaar Baron's Lobby. © agapps

import { DurableObject } from 'cloudflare:workers';

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.codes = null;
    this.rooms = null;
  }

  async #load() {
    if (this.codes && this.rooms) return;
    const codes = (await this.ctx.storage.get('codes')) || [];
    const rooms = (await this.ctx.storage.get('rooms')) || {};
    this.codes = new Set(codes);
    this.rooms = new Map(Object.entries(rooms));
  }

  async #persist() {
    await this.ctx.storage.put('codes', [...this.codes]);
    await this.ctx.storage.put('rooms', Object.fromEntries(this.rooms));
  }

  #allocateCode() {
    for (let i = 0; i < 50; i++) {
      const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      if (!this.codes.has(code)) return code;
    }
    for (let n = 0; n < 1000000; n++) {
      const code = String(n).padStart(6, '0');
      if (!this.codes.has(code)) return code;
    }
    return null;
  }

  async fetch(request) {
    await this.#load();
    const url = new URL(request.url);
    const op = url.pathname.replace(/^\//, '');
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
    }

    switch (op) {
      case 'allocate': {
        const code = this.#allocateCode();
        if (code == null) return json({ error: 'no-codes' }, 503);
        this.codes.add(code);
        this.rooms.set(code, {
          code,
          visibility: body.visibility || 'private',
          players: 0,
          capacity: body.seats || 4,
          host: body.host || '',
          phase: 'lobby',
        });
        await this.#persist();
        return json({ code });
      }
      case 'update': {
        const { code } = body;
        if (!code || !this.codes.has(code)) return json({ ok: false });
        if (body.visibility === 'public' && body.phase === 'lobby' && !body.full) {
          this.rooms.set(code, {
            code,
            visibility: 'public',
            players: body.players,
            capacity: body.capacity,
            host: body.host,
            phase: 'lobby',
          });
        } else {
          this.rooms.delete(code);
        }
        await this.#persist();
        return json({ ok: true });
      }
      case 'list': {
        const rooms = [...this.rooms.values()]
          .filter((r) => r.visibility === 'public' && r.phase === 'lobby' && r.players < r.capacity)
          .map((r) => ({ code: r.code, players: r.players, capacity: r.capacity, host: r.host }));
        return json({ rooms });
      }
      case 'close': {
        const { code } = body;
        if (code) {
          this.codes.delete(code);
          this.rooms.delete(code);
          await this.#persist();
        }
        return json({ ok: true });
      }
      default:
        return json({ error: 'unknown-op' }, 404);
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
