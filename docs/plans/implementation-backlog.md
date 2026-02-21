# 実装バックログ（Fact-First移行後）

最終更新: 2026-02-22

## 方針
- 事実（claim）を正本にして、原文は根拠参照に限定する
- 解析は LLM structured output を主系に固定する
- 失敗時はフォールバックせず再試行キューで運用する

## P0（完了）
- [x] lock/sync UI導線の削除（ホーム起点の操作へ一本化）
- [x] `fact_*` テーブル追加 + `notes/tasks/key_facts` の legacy 化（Neon migration）
- [x] `extract_claims_llm.py` による LLM構造化抽出を追加
- [x] high-risk block / medium-risk mask の送信制御を追加
- [x] `/analysis/run` を jobベース契約へ更新（extractor入力廃止）
- [x] `/analysis/jobs`, `/facts/search`, `/facts/by-entry/:id` を追加

## P1（次に着手）
- [ ] `extract_claims_llm.py` のリトライワーカー（queued -> running）を cron/automation 化
- [ ] claim抽出プロンプトを入力タイプ別（journal/todo/meeting等）に最適化
- [ ] `fact_claims` 用の検索ランキング（modality/certainty/time）を実装
- [ ] `analysisStatus` をホーム一覧カードに明示表示
- [ ] Neon E2E（API + worker + web + migration）統合テストを追加

## P2（検索/想起の実用化）
- [x] `facts` 参照APIを追加（text/type/modality/predicateフィルタ）
- [ ] ダッシュボードに「会話用Recallカード」を追加（実績/学び/根拠）
- [ ] タグ・時系列・タイプ横断の検索速度計測を追加
- [ ] claim + evidence を使った会話アシスト向け retrieval API を追加

## P3（安全運用）
- [ ] pre-commit/CI に secret + PII スキャンを導入
- [x] high-risk 入力の OpenAI送信ブロックを worker 側で強制
- [ ] エクスポートJSONL（監査/移行用）を `scripts/export` に実装
- [ ] バックアップ/リストア手順を runbook 化
- [ ] `.env` 管理と環境別設定（local/staging/prod）を整理

## P4（自動整理と会話アシストの土台）
- [ ] 週次サマリ自動生成ジョブを追加
- [ ] TODO抽出・決定抽出を claim/predicate ベースで定期ジョブ化
- [ ] 会話アシスト用の Retrieval API（短文候補 + 根拠）を追加
- [ ] 禁則情報フィルタ（マスク/警告）を提案生成パスへ組み込み
- [ ] 音声入力を保存しないモード（要約のみ保存）を設計/実装

## Done定義（各タスク共通）
- [ ] 単体テスト + 統合テストが追加されている
- [ ] Runbook/README が更新されている
- [ ] 手元で `pnpm dev` と `pnpm vercel-build` が通る
- [ ] Pythonワーカー側は `requirements.txt` で再現可能
