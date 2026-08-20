# BurningWish

サイトの中で他のウェブサイトをそのまま閲覧できる、書き換え型のプロキシブラウザ。
Cloudflare Workers + Static Assets 上で動作し、依存パッケージはありません。

## 構成

| パス | 役割 |
|---|---|
| `public/index.html` | フロントエンド一式(黒基調のブラウザ風 UI)。静的アセットとして配信される |
| `worker.js` | `/proxy` を処理する Worker。上流の取得・URL 書き換え・Cookie 管理を担当 |
| `wrangler.jsonc` | Cloudflare のデプロイ設定 |

公開する静的ファイルは `public/` だけに限定している。
ここをプロジェクトルート(`.`)にすると、wrangler が生成する `.wrangler/` を自分で検知して
**無限リロードに陥りローカル dev が応答しなくなる**うえ、`worker.js` まで配信対象に含まれてしまう。

## 動かし方

Node.js が必要。

```bash
npx wrangler dev
```

`http://localhost:8787` を開く。デプロイは `npx wrangler deploy`。

## 仕組み

1. クライアントは iframe の src に `/proxy?url=<絶対URL>` を指定する
2. Worker が上流を取得し、`HTMLRewriter` で HTML 内のあらゆる URL
   (`a`, `link`, `script`, `img`, `srcset`, `iframe`, `form`, `meta refresh`,
   インライン CSS) を `/proxy?url=...` へ書き換える
3. あわせてページ先頭にランタイムシムを注入し、JS が実行時に組み立てる遷移も矯正する

静的な書き換えだけでは JS が動的に作る遷移を捕まえられないため、この 2 段構えが必要になる。

### ランタイムシムが矯正するもの

- `fetch` / `XMLHttpRequest` / `navigator.sendBeacon`
- `history.pushState` / `replaceState`(親へ現在 URL を通知してアドレスバーを同期)
- `window.open`
- 動的に生成された `a` / `form`(クリック・送信をキャプチャ段階で拾う)
- **フレーム脱出対策**: インライン script 内の `parent.location` / `top.location` を
  サーバー側で `__bwLoc` へ書き換え、`parent.location.replace(...)` 型の遷移を
  プロキシ経由へ矯正する。`__bwLoc` はアクセサなので `parent.location = url` の
  直接代入型も拾える
- Service Worker は経路を横取りして破綻させるため無効化

### そのほかの挙動

- **リダイレクト**: `redirect: "manual"` で受け、`/proxy?url=<解決後>` への 302 に
  差し替える。iframe 自身の URL が常に正確になり、アドレスバーが追従する
- **自オリジンへ逃げた遷移の救済**: ページが `/foo` のような自オリジンの絶対パスへ
  遷移した場合、本来の行き先へ送り直す。文脈は Referer から取り、取れないときは
  HTML 応答時に残しておく `bwctx` Cookie を使う(Referer が付かない遷移があるため)。
  あわせて応答に `Referrer-Policy: same-origin` を設定し、
  自オリジンには完全な Referer を送りつつ外部へは一切送らないようにしている
- **Cookie**: 上流の `Set-Cookie` を登録可能ドメイン単位でまとめ、自オリジンの
  `bwcj_<domain>` cookie (HttpOnly) に保存して次回リクエストで送り返す
- **埋め込み阻害ヘッダ**: `X-Frame-Options` / `Content-Security-Policy` /
  `Cross-Origin-*-Policy` などを除去する
- **文字コード**: `Content-Type` に charset が無い場合は本文先頭の `<meta charset>` を
  覗いて判定する。Shift_JIS / EUC-JP は `TextDecoder` でデコードしてから
  正規表現で書き換え、UTF-8 として返す(`HTMLRewriter` は UTF-8 前提のため)
- **実体参照**: `HTMLRewriter` の `getAttribute` は `&amp;` を解かないので、
  属性値は自前でデコードしてから URL 解決する
- **再試行**: 上流が 429 / 503 を返した場合、ジッター付きで最大 4 回まで再試行する
- **SSRF 対策**: `localhost`、プライベート IP、`169.254.169.254`(クラウドの
  メタデータ endpoint)などへのアクセスを拒否する

## YouTube

YouTube の動画配信 URL (`googlevideo.com`) は**取得時のクライアント IP を署名に含む**ため、
出口 IP が毎回変わる Cloudflare Workers 経由では必ず 403 になり再生できない
(実測: プレーヤーは起動し duration も取れるが、映像セグメントが一つも届かない)。

そこで **動画ページだけはプロキシを通さず、公式の埋め込みプレーヤーを直接読み込む**。
埋め込みプレーヤーは第三者サイトへの iframe 埋め込みが公式に想定されており、
利用者自身の回線で再生されるため確実に動く。

- 対象: `youtube.com/watch`、`youtu.be/`、`shorts/`、`live/`、`embed/`、
  `m.` / `music.` サブドメイン、`playlist?list=`
- `t=90` や `t=1h2m3s` の開始位置指定も引き継ぐ
- 埋め込み URL に `origin` / `widget_referrer` / `enablejsapi` を付ける。
  YouTube は埋め込み元オリジンを識別できないと再生を拒否する(エラー153)ため、
  Referer に頼らず明示する。あわせて index.html に
  `<meta name="referrer" content="strict-origin-when-cross-origin">` を置いている
- 再生できない動画(提供者が埋め込みを禁止しているなど)は IFrame API の
  `onError` を受けて案内を表示し、「YouTube で開く」で外部タブに逃がす
- **埋め込みプレーヤーの iframe には `sandbox` を付けない。** Safari は
  sandbox 下の別オリジン iframe のストレージアクセスを強く制限するため、
  プレーヤーが初期化に失敗してエラー153 になる(Chrome では再現しない)。
  公式プレーヤーを直接読み込んでいるので隔離の必要もない。
  プロキシ経由の内容には従来どおり sandbox を付けるので、
  モードが切り替わるときは iframe 要素ごと作り直している
- ホームボタンを押したときは iframe を隠すだけでなく要素ごと破棄する。
  隠すだけでは中の動画が鳴り続けるため
- 動画以外のページ(トップ、検索、チャンネル)は従来どおりプロキシ経由で表示する
- **検索ボックスの Enter を横取りして `/results?search_query=...` へ通常遷移させる。**
  YouTube は Enter を JS で握りつぶし submit イベントを一切発火させないうえ、
  SPA 側のルーティングはプロキシ下では動かないため、検索結果が出せなかった。
  検索結果ページ自体は通常のページ遷移なら正しく表示できる
- プロキシ経由のページ内で動画リンクを押した場合も、シムが行き先を親へ通知して
  埋め込みプレーヤーへ切り替える(YouTube の SPA が動的に生成したリンクにも対応)
- この間だけ通信がプロキシを経由しない。ステータスバーに「直接接続」と表示する

## 既知の限界

- **`location.replace` / `location.href` は仕様上パッチできない**(非設定可能プロパティ)。
  ページが自分自身を絶対 URL で外部サイトへ飛ばした場合は捕まえられない。
  その場合はプロキシの外へ出たことを検知して案内を表示し、戻れるようにしている
- **WebSocket は代理できない。** リアルタイム通信に依存する機能は動作しない
- 画像が多いページでは、ローカル dev(住宅 IP)だと配信元のレート制限に当たって
  一部が欠けることがある。本番の Cloudflare エッジでは発生しない(実測 100/100)
- **YouTube の埋め込みプレーヤーはプロキシを経由しない**(上記のとおり経由すると
  再生できないため)。コメント欄や関連動画は表示されず、動画本体の再生のみになる
- YouTube の検索結果のサムネイルは、JS が描画後に src を差し込むため
  サーバー側の書き換えが効かず `i.ytimg.com` から直接読み込まれる(表示自体は正常)
- **検索エンジンはボット対策が厳しい。** Cloudflare のデータセンター IP に対し、
  Google は `/sorry/` へ、Mojeek・Startpage は CAPTCHA、Ecosia は 403 を返す。
  **DuckDuckGo は Cookie を一切発行せず IP だけで判定する**ため、出口 IP が
  毎回変わる Workers からだと CAPTCHA を通過しても次のリクエストで再び弾かれる
  (本番実測: Lite 版でも 6 回に 1 回失敗)。
  本番で 10 回試して安定したのは **Brave Search**(9/10)と Bing(10/10)。
  Bing は結果リンクが JS リダイレクトの中継ページを挟むため、
  直リンクを返す **Brave Search を既定**にしている
- **重い SPA サイトでは、記事ページへ進むとプロキシの外へ出ることがある。**
  外部 JS が絶対 URL で `location.href` を書き換える経路は仕様上捕まえられない。
  検知して案内を表示し、戻れるようにしている(例: Yahoo!ニュースの個別記事)
- ページ内の JS が `location.hostname` を読むと、プロキシ側のホスト名が見える
  (`parent.location` 経由なら本来の URL を返すよう偽装している)

## ホーム画面の注記

利用者向けに、スタート画面へ以下を明記している。

- 推奨環境は Chrome。Safari など他のブラウザでは一部のサイトが正しく動作しないことがある
- YouTube は動画のみ再生でき、関連動画やコメント欄は表示されない

## セキュリティ上の注意

プロキシしたページを **同一オリジンで実行** している
(iframe の sandbox に `allow-same-origin` を付与)。リンク・フォーム・ログイン・
SPA を成立させるために必要だが、閲覧先サイトの JS が自ドメインの Cookie や
localStorage にアクセスできる状態でもある。

不特定多数に公開する場合は、プロキシ内容を別サブドメインから配信して
本体サイトと分離することを推奨する。
