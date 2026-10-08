# LUMEN KART オンライン対戦サーバー

DANGO BATTLE のサーバー(dango-battle-server)と同じ仕様・同じ構成の、LUMEN KART 用 Socket.IO サーバーです。

- Express + Socket.IO(名前空間 `/lumen`)
- 合言葉の部屋(2〜4人・5文字)/ ランダムマッチ(2人・60秒で match:timeout)
- 再接続(切断から20秒以内なら `room:resume` で同じ席へ)/ 再戦(全員が押したらロビーへ)
- 受け取るデータの検証(決まった項目だけ中継)/ 送信回数の上限(部屋操作は少なめ、位置同期は多め)
- `/healthz` でヘルスチェック(Render 用)

## 動かす
```
npm ci
npm start        # http://localhost:3000
npm test         # 通しテスト(test/smoke.js)
```

## Render にデプロイ
1. このフォルダを GitHub の新しいリポジトリ(例: lumen-kart-server)に push
2. Render → New → Blueprint でそのリポジトリを選ぶ(render.yaml の設定で作られる)
   - サービス名 `lumen-kart-online` → URL は通常 https://lumen-kart-online.onrender.com
3. URL が違う場合は、ゲーム側 `online.js` の先頭 `LUMEN_ONLINE_URL` を書き換える

※ 無料プランは15分ほど使われないと眠ります。最初の接続は起きるまで最大1分ほどかかります(ゲーム側で「最大1分」と表示)。

## DANGO BATTLE のサーバーに同居させる場合(サーバーを1つにまとめたいとき)
`server/lumen.js` と `server/lumenRooms.js` を dango-battle-server の `server/` にコピーし、server.js の `const io = new Server(...)` の下に1行足すだけで動きます。
```js
require('./lumen')(io);   // LUMEN KART(名前空間 /lumen)
```
DANGO BATTLE の対戦(既定の名前空間)には影響しません。この場合は `LUMEN_ONLINE_URL` を DANGO BATTLE のサーバーの URL にします。

## イベント一覧(名前空間 /lumen)
| クライアント → サーバー | 内容 |
|---|---|
| ping-check | サーバー時刻(時計合わせ) |
| room:create / room:join / room:leave / room:resume | 部屋 |
| match:quick / match:cancel | ランダムマッチ |
| player:update | 車・名前・READY |
| room:course / room:start | ホストのコース選択・スタート |
| game:state | 自分の車の位置(1秒15回)。ホストはCPUの位置も |
| game:event | 光の壁を置いた |
| game:finish | ゴールタイム |
| rematch:request | 再戦 |

| サーバー → クライアント | 内容 |
|---|---|
| room:state / room:matched / lobby:count / match:timeout | 部屋・マッチ |
| race:start | 開始時刻・コース・グリッド |
| peer:state / peer:event | 相手の位置・光の壁 |
| peer:reconnecting / peer:resumed / peer:left | 相手の接続状態 |
| race:finish / race:results | だれかのゴール / 結果(最初のゴールから最長40秒で締め切り) |
| rematch:requested / rematch:start | 再戦 |
