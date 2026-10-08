// LUMEN KART - オンライン対戦(Socket.IO 名前空間 /lumen)
// DANGO BATTLE サーバーと同じ仕様:合言葉の部屋 / ランダムマッチ(60秒) / 再接続(20秒) / 再戦 /
//   受け取るデータの検証 / 送信回数の上限 / ack は必ず {ok, ...} で返す
// 使い方:const attachLumen = require('./lumen'); attachLumen(io);
//   → 既存の DANGO BATTLE サーバーに2行足すだけでも、単独のサーバーでも動く。
const { LumenRooms } = require('./lumenRooms');

const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 20 * 1000; // 切断後に復帰を待つ時間
const FINISH_WAIT_MS = Number(process.env.FINISH_WAIT_MS) || 40 * 1000;        // 最初のゴールから結果確定までの最長時間
const LOBBY_COUNT_INTERVAL_MS = 10 * 1000;
const COURSE_COUNT = 7;   // コース数(index.html の courses と合わせる)
const CAR_COUNT = 6;
const START_DELAY_MS = 1500; // race:start から実際のカウントダウン開始まで(全員に届く余裕)

// ================= 受け取るデータの検証 =================
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
function cleanToken(v) { return typeof v === 'string' && /^[a-z0-9]{8,64}$/i.test(v) ? v : null; }
function cleanInt(v, max) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; }
function cleanName(v) {
  if (typeof v !== 'string') return 'PLAYER';
  const s = v.replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 12);
  return s || 'PLAYER';
}
// 車1台ぶんの状態(決まった項目だけ取り出す)
function cleanCar(d) {
  d = obj(d); if (!d) return null;
  const s = num(d.s, -1e6, 1e6), lane = num(d.lane, -2000, 2000);
  if (s === undefined || lane === undefined) return null;
  const out = { s, lane,
    yaw: num(d.yaw, -4, 4) || 0, v: num(d.v, -50, 2000) || 0, h: num(d.h, -2000, 5000) || 0,
    roll: num(d.roll, -4, 4) || 0, pitch: num(d.pitch, -4, 4) || 0, steer: num(d.steer, -1, 1) || 0 };
  if (d.air === true) out.air = true;
  if (d.drift === true) out.drift = true;
  const drive = num(d.drive, 0, 10); if (drive) out.drive = drive;
  const stun = num(d.stun, 0, 5); if (stun) out.stun = stun;
  const fin = num(d.fin, 0, 3600); if (fin !== undefined) out.fin = fin;
  return out;
}
function cleanState(d) {
  d = obj(d); if (!d) return null;
  const me = cleanCar(d); if (!me) return null;
  me.t = num(d.t, 0, 1e7) || 0;
  if (Array.isArray(d.cpus)) {      // ホストだけが CPU の状態を送る
    if (d.cpus.length > 5) return null;
    me.cpus = d.cpus.map(cleanCar).map(c => c || null);
  }
  return me;
}
function cleanEvent(d) {
  d = obj(d); if (!d) return null;
  if (d.type === 'glow') {
    const s = num(d.s, -1e6, 1e6), lane = num(d.lane, -2000, 2000);
    if (s === undefined || lane === undefined) return null;
    const out = { type: 'glow', s, lane };
    const cpu = cleanInt(d.cpu, 4); if (cpu !== null) out.cpu = cpu; // CPUが置いた光の壁(ホストのみ)
    return out;
  }
  return null;
}

// ================= 送信回数の上限(DANGO と同じバケツ方式) =================
const LIMITS = {
  game: { capacity: 90, perSec: 40 },     // 位置の同期は1秒15回なので余裕あり
  control: { capacity: 12, perSec: 1.5 },
};
function allow(socket, kind) {
  const lim = LIMITS[kind];
  const now = Date.now();
  const b = socket.data.buckets[kind] || (socket.data.buckets[kind] = { tokens: lim.capacity, at: now });
  b.tokens = Math.min(lim.capacity, b.tokens + ((now - b.at) / 1000) * lim.perSec);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

module.exports = function attachLumen(io, options = {}) {
  const nsp = io.of(options.namespace || '/lumen');
  const rooms = new LumenRooms();
  const isAlive = id => nsp.sockets.has(id);
  const socketOf = id => nsp.sockets.get(id) || null;

  function roomState(room) {
    const host = rooms.host(room);
    return {
      code: room.code, status: room.status, isQuick: !!room.isQuick, course: room.course,
      hostSlot: host ? host.slot : null,
      players: room.players.map(p => ({ slot: p.slot, name: p.name, car: p.car, ready: p.ready, connected: p.connected, finished: p.finished }))
        .sort((a, b) => a.slot - b.slot),
    };
  }
  const broadcastState = room => nsp.to(room.code).emit('room:state', roomState(room));
  function currentRoom(socket) {
    const room = rooms.get(socket.data.roomCode);
    const me = rooms.findBySocket(room, socket.id);
    return me ? { room, me } : { room: null, me: null };
  }
  function attach(socket, room) {
    socket.join(room.code);
    socket.data.roomCode = room.code;
    rooms.touch(room);
  }
  const toOthers = (socket, room, ev, data) => socket.to(room.code).emit(ev, data);

  // ---------- レース ----------
  function startRace(room) {
    room.status = 'racing';
    room.players.forEach(p => { p.finished = null; p.rematch = false; });
    const startAt = Date.now() + START_DELAY_MS;
    room.race = { startAt, firstFinishAt: null, timer: null, seed: Math.floor(Math.random() * 1e9) };
    const grid = room.players.map(p => p.slot).sort((a, b) => a - b);
    rooms.touch(room);
    nsp.to(room.code).emit('race:start', { startAt, course: room.course, seed: room.race.seed, grid,
      players: roomState(room).players, hostSlot: rooms.host(room)?.slot ?? grid[0] });
  }
  function maybeAutoStart(room) {
    // ランダムマッチは2人ともREADYで自動スタート(DANGOの「2人ともキャラを選んだら開始」と同じ)
    if (room.isQuick && room.status === 'lobby' && room.players.length === 2 && room.players.every(p => p.ready && p.connected)) startRace(room);
  }
  function finishRace(room) {
    if (!room || room.status !== 'racing') return;
    if (room.race && room.race.timer) { clearTimeout(room.race.timer); room.race.timer = null; }
    room.status = 'finished';
    room.players.forEach(p => { p.ready = false; p.rematch = false; });
    const results = room.players
      .map(p => ({ slot: p.slot, name: p.name, car: p.car, time: p.finished }))
      .sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    rooms.touch(room);
    nsp.to(room.code).emit('race:results', { results });
    broadcastState(room);
  }
  function checkAllFinished(room) {
    if (room.status !== 'racing') return;
    const active = room.players.filter(p => p.connected);
    if (active.length === 0 || active.every(p => p.finished !== null)) finishRace(room);
  }

  // 自分から部屋を抜ける
  function leaveCurrent(socket) {
    rooms.dequeue(socket.id);
    socket.leave('lobby');
    const { room, me } = currentRoom(socket);
    if (room && me) {
      socket.leave(room.code);
      toOthers(socket, room, 'peer:left', { slot: me.slot });
      rooms.removePlayer(room, me);
      if (rooms.get(room.code)) {
        if (room.status === 'racing') checkAllFinished(room);
        broadcastState(room);
      }
    }
    socket.data.roomCode = null;
  }

  function sendLobbyCount(target) {
    const payload = { waiting: rooms.queue.length, online: nsp.sockets.size };
    (target || nsp.to('lobby')).emit('lobby:count', payload);
  }

  nsp.on('connection', socket => {
    socket.data.buckets = {};
    socket.data.token = null;
    const remember = data => {
      const d = obj(data) || {};
      const t = cleanToken(d.playerToken);
      if (t) socket.data.token = t;
      return { token: socket.data.token || socket.id, name: cleanName(d.name), car: cleanInt(d.car, CAR_COUNT - 1) ?? 0 };
    };
    const onControl = (ev, fn) => socket.on(ev, (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'control')) return reply({ ok: false, error: 'RATE_LIMITED' });
      try { fn(data, reply); } catch (e) { console.error('[LUMEN]', ev, e); reply({ ok: false, error: 'SERVER_ERROR' }); }
    });
    const onGame = (ev, fn) => socket.on(ev, (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'game')) return reply({ ok: false, error: 'RATE_LIMITED' });
      try { fn(data, reply); } catch (e) { console.error('[LUMEN]', ev, e); }
    });

    socket.on('ping-check', (p, ack) => { if (typeof ack === 'function') ack({ ok: true, serverTime: Date.now() }); });

    // ---- 合言葉の部屋 ----
    onControl('room:create', (data, reply) => {
      const { token, name, car } = remember(data);
      leaveCurrent(socket);
      const room = rooms.create(socket.id, token, name, car, false);
      attach(socket, room);
      reply({ ok: true, slot: 0, ...roomState(room) });
    });

    onControl('room:join', (data, reply) => {
      const { token, name, car } = remember(data);
      const code = str(obj(data)?.code, 10);
      if (!code) return reply({ ok: false, error: 'ROOM_NOT_FOUND' });
      leaveCurrent(socket);
      const r = rooms.join(code, socket.id, token, name, car);
      if (r.error) return reply({ ok: false, error: r.error });
      attach(socket, r.room);
      reply({ ok: true, slot: r.me.slot, ...roomState(r.room) });
      broadcastState(r.room);
    });

    // ---- ランダムマッチ ----
    onControl('match:quick', (data, reply) => {
      const { token, name, car } = remember(data);
      leaveCurrent(socket);
      const entry = { socketId: socket.id, token, name, car };
      const partner = rooms.enqueueOrMatch(entry, isAlive);
      const partnerSocket = partner && socketOf(partner.socketId);
      if (!partner || !partnerSocket) {
        if (partner) rooms.dequeue(partner.socketId);
        if (partner) rooms.enqueueOrMatch(entry, isAlive);
        socket.join('lobby');
        reply({ ok: true, waiting: true });
        sendLobbyCount(socket);
        return;
      }
      partnerSocket.leave('lobby');
      const room = rooms.createQuickRoom(partner, entry);
      attach(partnerSocket, room);
      attach(socket, room);
      const meSlot = rooms.findBySocket(room, socket.id).slot;
      reply({ ok: true, waiting: false, slot: meSlot, ...roomState(room) });
      partnerSocket.emit('room:matched', { slot: rooms.findBySocket(room, partner.socketId).slot, ...roomState(room) });
      broadcastState(room);
    });

    onControl('match:cancel', (data, reply) => {
      const removed = rooms.dequeue(socket.id);
      socket.leave('lobby');
      reply({ ok: true, removed });
    });

    // ---- 再接続 ----
    onControl('room:resume', (data, reply) => {
      const { token } = remember(data);
      const room = rooms.get(str(obj(data)?.code, 10));
      if (!room) return reply({ ok: false, error: 'ROOM_NOT_FOUND' });
      const me = room.players.find(p => p.token === token && !p.connected) || room.players.find(p => p.token === token);
      if (!me) return reply({ ok: false, error: 'NOT_IN_ROOM' });
      if (me.graceTimer) { clearTimeout(me.graceTimer); me.graceTimer = null; }
      const oldSocket = me.socketId !== socket.id ? socketOf(me.socketId) : null;
      if (oldSocket) { oldSocket.leave(room.code); oldSocket.data.roomCode = null; }
      me.socketId = socket.id;
      me.connected = true;
      attach(socket, room);
      reply({ ok: true, slot: me.slot, startAt: room.race?.startAt, ...roomState(room) });
      toOthers(socket, room, 'peer:resumed', { slot: me.slot });
      broadcastState(room);
    });

    onControl('room:leave', (data, reply) => { leaveCurrent(socket); reply({ ok: true }); });

    // ---- ロビー:車・名前・READY ----
    onControl('player:update', (data, reply) => {
      const { room, me } = currentRoom(socket);
      if (!room) return reply({ ok: false, error: 'NOT_IN_ROOM' });
      if (room.status === 'racing') return reply({ ok: false, error: 'BAD_STATE' });
      const d = obj(data) || {};
      const car = cleanInt(d.car, CAR_COUNT - 1); if (car !== null) me.car = car;
      if (typeof d.name === 'string') me.name = cleanName(d.name);
      if (typeof d.ready === 'boolean') me.ready = d.ready;
      rooms.touch(room);
      reply({ ok: true });
      broadcastState(room);
      maybeAutoStart(room);
    });

    // ---- ホスト:コース選択とスタート ----
    onControl('room:course', (data, reply) => {
      const { room, me } = currentRoom(socket);
      if (!room) return reply({ ok: false, error: 'NOT_IN_ROOM' });
      if (room.hostToken !== me.token || room.isQuick) return reply({ ok: false, error: 'NOT_HOST' });
      if (room.status === 'racing') return reply({ ok: false, error: 'BAD_STATE' });
      const course = cleanInt(obj(data)?.course, COURSE_COUNT - 1);
      if (course === null) return reply({ ok: false, error: 'BAD_COURSE' });
      room.course = course;
      room.players.forEach(p => { p.ready = false; });   // コースが変わったらREADYをやり直す
      rooms.touch(room);
      reply({ ok: true });
      broadcastState(room);
    });

    onControl('room:start', (data, reply) => {
      const { room, me } = currentRoom(socket);
      if (!room) return reply({ ok: false, error: 'NOT_IN_ROOM' });
      if (room.hostToken !== me.token) return reply({ ok: false, error: 'NOT_HOST' });
      if (room.status === 'racing') return reply({ ok: false, error: 'BAD_STATE' });
      const others = room.players.filter(p => p !== me);
      if (others.length === 0) return reply({ ok: false, error: 'NEED_PLAYERS' });
      if (!room.players.every(p => p.connected)) return reply({ ok: false, error: 'WAIT_RECONNECT' });
      if (!others.every(p => p.ready)) return reply({ ok: false, error: 'NOT_READY' });
      me.ready = true;
      reply({ ok: true });
      startRace(room);
    });

    // ---- レース中の同期(中身を検証してから他の人へ中継) ----
    onGame('game:state', data => {
      const { room, me } = currentRoom(socket); if (!room || room.status !== 'racing') return;
      const clean = cleanState(data); if (!clean) return;
      if (clean.cpus && room.hostToken !== me.token) delete clean.cpus;   // CPU の状態はホストだけ
      rooms.touch(room);
      clean.slot = me.slot;
      socket.to(room.code).volatile.emit('peer:state', clean);
    });
    onGame('game:event', data => {
      const { room, me } = currentRoom(socket); if (!room || room.status !== 'racing') return;
      const clean = cleanEvent(data); if (!clean) return;
      if (clean.cpu !== undefined && room.hostToken !== me.token) return;
      clean.slot = me.slot;
      socket.to(room.code).emit('peer:event', clean);
    });
    onControl('game:finish', (data, reply) => {
      const { room, me } = currentRoom(socket);
      if (!room || room.status !== 'racing') return reply({ ok: false, error: 'BAD_STATE' });
      const time = num(obj(data)?.time, 1, 3600);
      if (time === undefined) return reply({ ok: false, error: 'BAD_TIME' });
      if (me.finished === null) me.finished = time;
      rooms.touch(room);
      reply({ ok: true });
      nsp.to(room.code).emit('race:finish', { slot: me.slot, time: me.finished });
      if (!room.race.firstFinishAt) {
        room.race.firstFinishAt = Date.now();
        room.race.timer = setTimeout(() => finishRace(room), FINISH_WAIT_MS);   // 最初のゴールから40秒で締め切り
      }
      checkAllFinished(room);
    });

    // ---- 再戦(全員が押したらロビーへ戻る) ----
    onControl('rematch:request', (data, reply) => {
      const { room, me } = currentRoom(socket);
      if (!room || room.status !== 'finished') return reply({ ok: false, error: 'BAD_STATE' });
      me.rematch = true;
      rooms.touch(room);
      toOthers(socket, room, 'rematch:requested', { slot: me.slot });
      reply({ ok: true });
      if (room.players.every(p => p.rematch || !p.connected)) {
        room.players.forEach(p => { p.rematch = false; p.ready = false; p.finished = null; });
        room.status = 'lobby';
        nsp.to(room.code).emit('rematch:start');
        broadcastState(room);
      }
    });

    // ---- 切断:行列からは即削除、部屋は20秒だけ復帰を待つ ----
    socket.on('disconnect', () => {
      rooms.dequeue(socket.id);
      const { room, me } = currentRoom(socket);
      if (!room || !me) return;
      me.connected = false;
      rooms.touch(room);
      toOthers(socket, room, 'peer:reconnecting', { slot: me.slot });
      broadcastState(room);
      me.graceTimer = setTimeout(() => {
        me.graceTimer = null;
        if (me.connected || !rooms.get(room.code)) return;
        nsp.to(room.code).emit('peer:left', { slot: me.slot });
        rooms.removePlayer(room, me);
        if (rooms.get(room.code)) {
          if (room.status === 'racing') checkAllFinished(room);
          broadcastState(room);
        }
      }, RECONNECT_GRACE_MS);
      if (room.status === 'racing') checkAllFinished(room);
    });
  });

  // ================= 定期処理 =================
  const t1 = setInterval(() => {
    for (const e of rooms.takeTimedOut()) {
      const s = socketOf(e.socketId);
      if (s) { s.leave('lobby'); s.emit('match:timeout'); }
    }
  }, 1000);
  const t2 = setInterval(() => { if (rooms.queue.length) sendLobbyCount(); }, LOBBY_COUNT_INTERVAL_MS);
  const t3 = setInterval(() => rooms.cleanup(isAlive), 60 * 1000);
  [t1, t2, t3].forEach(t => t.unref && t.unref());

  return { nsp, rooms };
};
