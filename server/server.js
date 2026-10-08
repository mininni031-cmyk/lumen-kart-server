// LUMEN KART - オンライン対戦サーバー (Express + Socket.IO)
// DANGO BATTLE サーバーと同じ構成。対戦の処理は ./lumen.js(名前空間 /lumen)にまとめてある。
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const attachLumen = require('./lumen');

const PORT = process.env.PORT || 3000;

const app = express();
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/', (req, res) => res.type('text').send('LUMEN KART online server'));

const server = http.createServer(app);
// 巨大なデータは受け取らない(1メッセージ16KBまで)
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 16 * 1024 });
const lumen = attachLumen(io);

if (require.main === module) {
  server.listen(PORT, () => console.log(`[LUMEN SERVER] listening on ${PORT}`));
}
module.exports = { app, server, io, lumen };
