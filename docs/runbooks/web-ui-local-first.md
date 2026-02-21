# Web UI Local-first Runbook

## 目的
`apps/web` のUI MVPをローカルで起動し、6タイプ入力とTimeline検索を検証する。

## セットアップ
```bash
pnpm install
pnpm dev
```

`pnpm dev` は `apps/*` の `dev` スクリプトを並列実行する。
現状は `apps/web` のみ起動し、将来 `apps/api` に `dev` を追加すると同時起動される。

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

## テスト
```bash
pnpm web:test
```

## Vercel事前ビルドチェック
```bash
pnpm vercel-build
```

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
