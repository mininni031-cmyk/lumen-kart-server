// LUMEN KART サーバーの通しテスト:node test/smoke.js
process.env.RECONNECT_GRACE_MS = '1500';
process.env.FINISH_WAIT_MS = '1500';
process.env.QUEUE_TIMEOUT_MS = '1500';
const { io: Client } = require('socket.io-client');
const { server } = require('../server/server');

const assert = (c, m) => { if (!c) { console.error('NG:', m); process.exit(1); } console.log('OK:', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 3000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const call = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const waitFor = (s, ev, pred, ms = 3000) => new Promise((res, rej) => { const t = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, ms); const h = d => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } }; s.on(ev, h); });

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/lumen`;
  const mk = () => Client(url, { transports: ['websocket'], forceNew: true });
  const A = mk(), B = mk(), C = mk();
  await Promise.all([A, B, C].map(s => once(s, 'connect')));
  const tok = n => ('tok' + n + 'abcdefgh');

  const ping = await call(A, 'ping-check');
  assert(ping.ok && ping.serverTime > 0, 'ping-check でサーバー時刻')

  const a = await call(A, 'room:create', { playerToken: tok('A'), name: 'Ren<script>', car: 2 });
  assert(a.ok && /^[A-Z2-9]{5}$/.test(a.code) && a.slot === 0, '部屋を作る(合言葉5文字) code=' + a.code);
  assert(a.players[0].name === 'Renscript', '名前の危ない文字を消す');

  const bad = await call(B, 'room:join', { playerToken: tok('B'), code: 'ZZZZZ' });
  assert(!bad.ok && bad.error === 'ROOM_NOT_FOUND', 'ない合言葉は ROOM_NOT_FOUND');

  const stateP = once(A, 'room:state');
  const b = await call(B, 'room:join', { playerToken: tok('B'), code: a.code.toLowerCase(), name: 'Bee', car: 9 });
  assert(b.ok && b.slot === 1 && b.players.length === 2, '合言葉で参加(小文字でもOK)');
  assert(b.players[1].car === 0, '範囲外の車番号は0にする');
  assert((await stateP).players.length === 2, 'ホストに room:state が届く');
  const c = await call(C, 'room:join', { playerToken: tok('C'), code: a.code, name: 'Cee', car: 4 });
  assert(c.ok && c.slot === 2, '3人目も参加');

  const nh = await call(B, 'room:course', { course: 3 });
  assert(!nh.ok && nh.error === 'NOT_HOST', 'コースはホストだけ変えられる');
  assert((await call(A, 'room:course', { course: 6 })).ok, 'ホストがコースを変える');
  assert(!(await call(A, 'room:course', { course: 99 })).ok, '存在しないコースは拒否');

  const nr = await call(A, 'room:start');
  assert(!nr.ok && nr.error === 'NOT_READY', '全員READYでないとスタートできない');
  await call(B, 'player:update', { ready: true });
  await call(C, 'player:update', { ready: true, car: 5 });
  const startPs = [A, B, C].map(s => once(s, 'race:start'));
  assert((await call(A, 'room:start')).ok, 'ホストがスタート');
  const starts = await Promise.all(startPs);
  assert(starts.every(s => s.course === 6 && s.grid.join() === '0,1,2' && s.startAt > Date.now()), '全員に race:start(同じコース・グリッド・開始時刻)');

  const lateD = Client(url, { transports: ['websocket'], forceNew: true }); await once(lateD, 'connect');
  const late = await call(lateD, 'room:join', { playerToken: tok('D'), code: a.code });
  assert(!late.ok && late.error === 'RACE_IN_PROGRESS', 'レース中は途中参加できない');
  lateD.close();

  const pB = once(B, 'peer:state'), pC = once(C, 'peer:state');
  A.emit('game:state', { t: 1.2, s: 120.5, lane: -20, v: 300, yaw: .1, h: 60, drift: true, evil: 'x', cpus: [{ s: 100, lane: 10 }, { s: 90, lane: -10 }, { s: 'bad' }] });
  const sb = await pB; await pC;
  assert(sb.slot === 0 && sb.s === 120.5 && sb.drift === true && sb.evil === undefined, '位置を他の人へ中継(余計な項目は消す)');
  assert(sb.cpus.length === 3 && sb.cpus[2] === null, 'ホストのCPU状態も中継(壊れた要素は null)');
  const pA = once(A, 'peer:state');
  B.emit('game:state', { s: 50, lane: 0, cpus: [{ s: 1, lane: 1 }] });
  assert((await pA).cpus === undefined, 'ホスト以外のCPU状態は捨てる');
  const ev = once(A, 'peer:event');
  B.emit('game:event', { type: 'glow', s: 300, lane: 12 });
  assert((await ev).slot === 1, '光の壁イベントを中継');

  const fin = once(B, 'race:finish');
  assert((await call(A, 'game:finish', { time: 61.23 })).ok, 'ゴールを報告');
  assert((await fin).time === 61.23, '他の人に race:finish');
  await call(B, 'game:finish', { time: 63.5 });
  const resP = once(A, 'race:results');
  await call(C, 'game:finish', { time: 62.1 });
  const res = await resP;
  assert(res.results.map(r => r.slot).join() === '0,2,1', '全員ゴールで結果(タイム順)');

  const rq = once(B, 'rematch:requested');
  await call(A, 'rematch:request');
  assert((await rq).slot === 0, '再戦リクエストが届く');
  await call(B, 'rematch:request');
  const rs = once(A, 'rematch:start');
  await call(C, 'rematch:request');
  await rs; assert(true, '全員が押したら rematch:start でロビーへ');

  // 2回目:Cが途中で落ちても、締め切りで結果が出る
  await call(B, 'player:update', { ready: true }); await call(C, 'player:update', { ready: true });
  const s2 = once(A, 'race:start'); await call(A, 'room:start'); await s2;
  await call(A, 'game:finish', { time: 40 });
  const recon = once(A, 'peer:reconnecting');
  C.disconnect();
  assert((await recon).slot === 2, '切断すると peer:reconnecting');
  const C2 = mk(); await once(C2, 'connect');
  const resume = await call(C2, 'room:resume', { playerToken: tok('C'), code: a.code });
  assert(resume.ok && resume.slot === 2 && resume.status === 'racing', '20秒以内なら room:resume で同じ席に戻れる');
  const res2P = once(A, 'race:results', 4000);
  const r2 = await res2P;
  assert(r2.results[0].slot === 0 && r2.results.find(r => r.slot === 1).time === null, '最初のゴールから締め切り後に結果(未ゴールは null)');

  // ホストが抜けると次の人がホスト
  const st = waitFor(B, 'room:state', d => d.players.length === 2);
  await call(A, 'room:leave');
  assert((await st).hostSlot === 1, 'ホストが抜けたら次の人がホスト');

  // ランダムマッチ
  const Q1 = mk(), Q2 = mk(); await Promise.all([once(Q1, 'connect'), once(Q2, 'connect')]);
  const q1 = await call(Q1, 'match:quick', { playerToken: tok('Q1'), name: 'Q1' });
  assert(q1.ok && q1.waiting, 'ランダムマッチ:1人目は待機');
  const matched = once(Q1, 'room:matched');
  const q2 = await call(Q2, 'match:quick', { playerToken: tok('Q2'), name: 'Q2' });
  const m1 = await matched;
  assert(q2.ok && !q2.waiting && m1.code === q2.code && m1.slot !== q2.slot, 'ランダムマッチ:2人目で成立');
  const qs = once(Q1, 'race:start');
  await call(Q1, 'player:update', { ready: true }); await call(Q2, 'player:update', { ready: true });
  await qs; assert(true, 'ランダムマッチは2人ともREADYで自動スタート');
  const nj = await call(lateD.connected ? lateD : mk(), 'room:join', { code: q2.code });
  assert(!nj.ok, 'ランダムマッチの部屋には合言葉で入れない');

  const Q3 = mk(); await once(Q3, 'connect');
  await call(Q3, 'match:quick', { playerToken: tok('Q3') });
  await once(Q3, 'match:timeout', 4000); assert(true, '相手がいなければ match:timeout');

  // 連打対策
  let limited = false;
  for (let i = 0; i < 20; i++) { const r = await call(Q3, 'room:create', { playerToken: tok('Q3') }); if (r.error === 'RATE_LIMITED') { limited = true; break; } }
  assert(limited, '部屋操作の連打は RATE_LIMITED');

  console.log('\nALL OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
