# 実装バックログ（現時点）

最終更新: 2026-02-21

## 方針
- 先に「入力体験と契約」を固める
- 次に「同期と参照」を安定化する
- 最後に「自動化と会話アシスト」を積む

## P0（次に着手）
- [x] `apps/api` の最小実装（health, create-entry, list/search-entry, sync-queue）
- [x] Web の `RemoteRepository` を API 接続で動作させる（feature flagでLocal/Remote切替）
- [x] `sync` 画面で手動送信を実装（pending -> syncing -> synced/failed）
- [x] 競合解決を実装（LWW + history記録をUI表示）
- [ ] Neon の読み書き統合テストを追加（API + worker + web）

補足:
- Neon統合は `apps/api/tests/neon.integration.test.ts` を追加済み（API単体）。
- `API + worker + web` を一気通貫で検証するE2Eは未実装。

## P1（データ契約の固定）
- [ ] 6入力タイプごとの API 入力契約（Zod/JSON Schema）を固定
- [ ] UI入力 -> `captures_raw` へのマッピングを明文化（型別ルーティング）
- [ ] `process_captures` の型別処理分岐（journal/meeting/todo 等）を追加
- [ ] `extract_key_facts` の型別抽出ルール（meeting decisions/actions 優先など）を追加
- [ ] ワーカー契約JSONのバージョン運用ルールを `design/adr` に追加

## P2（検索/想起の実用化）
- [ ] 検索APIを追加（全文 + フィルタ + recency boost）
- [ ] `key_facts` 参照APIを追加（subject/predicate/object フィルタ）
- [ ] ダッシュボードに「会話用Recallカード」を追加（実績/学び/根拠）
- [ ] タグ・時系列・タイプ横断の検索速度計測を追加
- [ ] `pipeline_test_run` と同等の API 経由ドライラン機能を追加

## P3（安全運用）
- [ ] pre-commit/CI に secret + PII スキャンを導入
- [ ] high-risk 入力の保存ブロックを API 側でも強制
- [ ] エクスポートJSONL（監査/移行用）を `scripts/export` に実装
- [ ] バックアップ/リストア手順を runbook 化
- [ ] `.env` 管理と環境別設定（local/staging/prod）を整理

## P4（自動整理と会話アシストの土台）
- [ ] 週次サマリ自動生成ジョブを追加
- [ ] TODO抽出・決定抽出を定期ジョブ化
- [ ] 会話アシスト用の Retrieval API（短文候補 + 根拠）を追加
- [ ] 禁則情報フィルタ（マスク/警告）を提案生成パスへ組み込み
- [ ] 音声入力を保存しないモード（要約のみ保存）を設計/実装

## Done定義（各タスク共通）
- [ ] 単体テスト + 統合テストが追加されている
- [ ] Runbook/README が更新されている
- [ ] 手元で `pnpm dev` と `pnpm vercel-build` が通る
- [ ] Pythonワーカー側は `requirements.txt` で再現可能
