// LUMEN KART - 部屋とランダムマッチ待ち行列の管理(DANGO BATTLE の roomManager と同じ考え方)
// ・合言葉の部屋(2〜4人)とランダムマッチの部屋(2人)を、同じ「部屋」の仕組みで扱う
// ・プレイヤーは socket.id ではなく playerToken で識別する(再接続で socket.id が変わるため)
// ・部屋の中では slot(0〜3)で区別する。slot はレースのグリッド順・色にも使う

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
const ROOM_IDLE_TTL_MS = 10 * 60 * 1000;   // レース中以外で10分放置された部屋は片付ける
const ROOM_HARD_TTL_MS = 60 * 60 * 1000;   // どんな状態でも1時間を超えた部屋は片付ける
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 60 * 1000; // ランダムマッチの待ち時間の上限

class LumenRooms {
  constructor() {
    this.rooms = new Map();   // code -> room
    this.queue = [];          // ランダムマッチ待ち行列 [{socketId, token, name, car, since}]
  }

  newCode() {
    let c = '';
    do {
      c = '';
      for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (this.rooms.has(c));
    return c;
  }

  freeSlot(room) {
    for (let i = 0; i < MAX_PLAYERS; i++) if (!room.players.some(p => p.slot === i)) return i;
    return -1;
  }

  newPlayer(room, socketId, token, name, car) {
    return { socketId, token, slot: this.freeSlot(room), name, car, ready: false, connected: true,
      finished: null, rematch: false, graceTimer: null };
  }

  create(socketId, token, name, car, isQuick = false) {
    const now = Date.now();
    const room = {
      code: this.newCode(),
      status: 'lobby',          // lobby / racing / finished
      isQuick,
      course: 0,
      hostToken: token,
      createdAt: now,
      lastActivityAt: now,
      race: null,               // {startAt, firstFinishAt, timer}
      players: [],
    };
    room.players.push(this.newPlayer(room, socketId, token, name, car));
    this.rooms.set(room.code, room);
    return room;
  }

  join(code, socketId, token, name, car) {
    const room = this.get(code);
    if (!room || room.isQuick) return { error: 'ROOM_NOT_FOUND' };   // ランダムマッチの部屋には合言葉で入れない
    const same = room.players.find(p => p.socketId === socketId);
    if (same) return { room, me: same };
    if (room.status !== 'lobby') return { error: 'RACE_IN_PROGRESS' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'ROOM_FULL' };
    const me = this.newPlayer(room, socketId, token, name, car);
    room.players.push(me);
    this.touch(room);
    return { room, me };
  }

  createQuickRoom(a, b) {
    const room = this.create(a.socketId, a.token, a.name, a.car, true);
    room.players.push(this.newPlayer(room, b.socketId, b.token, b.name, b.car));
    room.course = Math.floor(Math.random() * 7);   // ランダムマッチはコースもランダム
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  touch(room) { if (room) room.lastActivityAt = Date.now(); }
  findBySocket(room, socketId) { return room ? room.players.find(p => p.socketId === socketId) || null : null; }
  host(room) { return room.players.find(p => p.token === room.hostToken) || null; }

  removePlayer(room, player) {
    if (!room || !player) return;
    if (player.graceTimer) { clearTimeout(player.graceTimer); player.graceTimer = null; }
    room.players = room.players.filter(p => p !== player);
    this.touch(room);
    if (room.players.length === 0) { this.deleteRoom(room.code); return; }
    if (room.hostToken === player.token) room.hostToken = room.players[0].token; // ホストが抜けたら次の人がホスト
    if (room.status !== 'racing') room.players.forEach(p => { p.ready = false; p.rematch = false; });
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.players.forEach(p => { if (p.graceTimer) clearTimeout(p.graceTimer); });
    if (room.race && room.race.timer) clearTimeout(room.race.timer);
    this.rooms.delete(code);
  }

  // ---------- ランダムマッチ待ち行列 ----------
  enqueueOrMatch(entry, isAlive) {
    this.dequeue(entry.socketId);
    const idx = this.queue.findIndex(e => e.token !== entry.token && e.socketId !== entry.socketId && isAlive(e.socketId));
    if (idx >= 0) {
      const partner = this.queue[idx];
      this.queue.splice(idx, 1);
      return partner;
    }
    this.queue.push({ ...entry, since: Date.now() });
    return null;
  }

  dequeue(socketId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(e => e.socketId !== socketId);
    return before !== this.queue.length;
  }

  takeTimedOut(now = Date.now()) {
    const expired = this.queue.filter(e => now - e.since >= QUEUE_TIMEOUT_MS);
    if (expired.length) this.queue = this.queue.filter(e => now - e.since < QUEUE_TIMEOUT_MS);
    return expired;
  }

  cleanup(isAlive, now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivityAt;
      const age = now - room.createdAt;
      const nobodyHere = room.players.every(p => !p.connected || !isAlive(p.socketId));
      if (nobodyHere && idle > 30 * 1000) { this.deleteRoom(code); continue; }
      if (room.status !== 'racing' && idle > ROOM_IDLE_TTL_MS) { this.deleteRoom(code); continue; }
      if (age > ROOM_HARD_TTL_MS && idle > ROOM_IDLE_TTL_MS / 2) { this.deleteRoom(code); continue; }
    }
    this.queue = this.queue.filter(e => isAlive(e.socketId));
  }
}

module.exports = { LumenRooms, MAX_PLAYERS, QUEUE_TIMEOUT_MS };
