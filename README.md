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
- **フレーム脱出対策**: `window.parent` を差し替え、`parent.location.replace(...)` 型の
  遷移(DuckDuckGo の検索結果中継ページなど)をプロキシ経由へ矯正する。
  `frameElement` は `null` を返して埋め込み検知も避ける
- Service Worker は経路を横取りして破綻させるため無効化

### そのほかの挙動

- **リダイレクト**: `redirect: "manual"` で受け、`/proxy?url=<解決後>` への 302 に
  差し替える。iframe 自身の URL が常に正確になり、アドレスバーが追従する
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

## 既知の限界

- **`location.replace` / `location.href` は仕様上パッチできない**(非設定可能プロパティ)。
  ページが自分自身を絶対 URL で外部サイトへ飛ばした場合は捕まえられない。
  その場合はプロキシの外へ出たことを検知して案内を表示し、戻れるようにしている
- **WebSocket は代理できない。** リアルタイム通信に依存する機能は動作しない
- **画像が多いページでは一部が欠けることがある。** 100 枚の画像要求が Worker から
  一斉に上流へ飛ぶため、配信元(例: Wikimedia)のレート制限に当たる。再試行で緩和している
- **Google などボット対策の強いサイト**は、データセンター IP からのアクセスとして
  判定され `/sorry/` に飛ばされることがある。アドレスバーからの検索は DuckDuckGo を既定にしている
- ページ内の JS が `location.hostname` を読むと、プロキシ側のホスト名が見える
  (`parent.location` 経由なら本来の URL を返すよう偽装している)

## セキュリティ上の注意

プロキシしたページを **同一オリジンで実行** している
(iframe の sandbox に `allow-same-origin` を付与)。リンク・フォーム・ログイン・
SPA を成立させるために必要だが、閲覧先サイトの JS が自ドメインの Cookie や
localStorage にアクセスできる状態でもある。

不特定多数に公開する場合は、プロキシ内容を別サブドメインから配信して
本体サイトと分離することを推奨する。
