# 実装バックログ（Fact-Centric v2）

最終更新: 2026-02-22

## 現在の前提
- DB正本は Neon（PostgreSQL）
- 入力は即DB保存（同期キュー思想は廃止）
- 解析は手動トリガー（ホーム/解析履歴から実行）
- 抽出は LLM Structured Output 主系

## P0（今回完了）
- [x] `fact_semantic_v2` マイグレーション追加（Neon + SQLite mirror）
- [x] `fact_extractions` / `fact_claim_dimensions` / `fact_rollups` / `fact_analysis_artifacts` / `fact_claim_feedback` 追加
- [x] `fact_claims` に `object_text_raw` / `object_text_canonical` / `me_role` / `quality_*` を追加
- [x] APIを `analysis/jobs` / `facts/claims` / `rollups` 中心へ更新
- [x] Webに `/facts` と `/facts/:claimId` を追加
- [x] claim手動改訂（supersede）と retract UI/APIを追加
- [x] 解析履歴ページで job/item/facts の追跡を可能化
- [x] OpenAI利用ログ集計の互換維持

## P1（次に実装）
- [ ] `quality_flags` の判定ロジックを worker側で具体化（文脈欠落・主語曖昧など）
- [ ] `queued_retry` を再実行する定期ジョブ（cron/automation）を追加
- [ ] `analysis_state` と `latest_analysis_job_id` を全一覧UIに明示
- [ ] claim検索のランキング改善（recency + certainty + me_role重み）
- [ ] `/facts` の dimension フィルタに複合条件（AND）を追加

## P2（品質・運用）
- [ ] claim手動改訂の差分表示を改善（before/after diff）
- [ ] 解析失敗のエラー分類ダッシュボードを `/analysis-history` に追加
- [ ] rollup生成を LLM要約へ拡張（現状は簡易要約）
- [ ] `fact_analysis_artifacts.expires_at` のクリーンアップジョブを追加
- [ ] 監査用エクスポート（claims + evidence + feedback JSONL）を追加

## P3（スケール）
- [ ] `fact_claims.object_text_canonical` の全文索引を評価し必要なら PGroonga/外部検索を検討
- [ ] `fact_claim_dimensions` の高頻度軸に部分索引追加
- [ ] 10万entry性能検証（`/facts/claims` 95p < 400ms）を測定
- [ ] バックフィル再実行スクリプトを追加（idempotent）
- [ ] cold-storage向け圧縮戦略（raw保持期間 + rollup永続）を定義

## 完了定義（共通）
- [ ] API/Web/Python の対象テストが追加されている
- [ ] `pnpm --filter brain-dock-api build` が通る
- [ ] `pnpm --filter brain-dock-web build` が通る
- [ ] 主要ユニット/統合テストが通る
- [ ] docs/architecture に仕様差分が反映されている
