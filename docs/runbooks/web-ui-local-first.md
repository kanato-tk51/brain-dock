# Web UI Local-first Runbook

## 目的
`apps/web` のUI MVPをローカルで起動し、6タイプ入力とTimeline検索を検証する。

## セットアップ
```bash
pnpm install
pnpm dev
```

`pnpm dev` は `apps/*` の `dev` スクリプトを並列実行する。
現状は `apps/web` と `apps/api` が同時起動される。

RepositoryをAPI接続に切り替える場合:
```bash
# デフォルトは remote
# local-firstで試したい場合だけ local/hybrid を指定
# export NEXT_PUBLIC_REPOSITORY_MODE=local
export NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
pnpm dev
```

## URL
- `http://localhost:3000/`
- `http://localhost:3000/capture/journal`
- `http://localhost:3000/capture/todo`
- `http://localhost:3000/capture/learning`
- `http://localhost:3000/capture/thought`
- `http://localhost:3000/capture/meeting`
- `http://localhost:3000/capture/wishlist`
- `http://localhost:3000/sync`
- `http://localhost:3000/lock`
- `http://localhost:8787/health` (API health)

## テスト
```bash
pnpm web:test
```

## Vercel事前ビルドチェック
```bash
pnpm vercel-build
```

このコマンドは Neon migration 実行後に Web build を行う。
実行には `NEON_DATABASE_URL` が必要。

Production環境変数をpullしてから確認する場合:
```bash
pnpm vercel-build-with-env
```

## 実装ポイント
- Repository abstraction
- IndexedDB local store
- Manual sync queue
- PIN lock
- PII warn/block
