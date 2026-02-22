# Fact-Centric v2（LLM主導 / Me中心）

## 目的
Brain Dock の記憶正本を「生テキスト単体」から「私中心の claim」に移し、後から高速に参照できる状態を作る。  
同時に、意味保全のために原文と根拠スパンを必ず保持する。

## v2の正本レイヤー
1. `fact_documents`
- 入力原文の不変保存
- `raw_text`, `normalized_text`, `language`, `token_count`, `analysis_state`, `last_analyzed_at`

2. `fact_claims`
- 参照/検索の主対象
- `subject_text`, `predicate`
- `object_text_raw`（原文寄り）
- `object_text_canonical`（単独で意味が通る補完済み）
- `me_role`, `modality`, `polarity`, `certainty`
- `quality_score`, `quality_flags`
- `status`, `supersedes_claim_id`

3. `fact_evidence_spans`
- claim根拠の原文断片 + 位置（offset）

4. `fact_claim_dimensions`
- 高速検索用の軸（person/place/activity/emotion/health/topic/...）

5. `fact_rollups`
- 日/週/月などの圧縮記憶（再構成可能）

6. `fact_extractions`
- 1ドキュメント1抽出試行の監査ログ
- model, reasoning_effort, status, token/cost, error情報

7. `fact_analysis_artifacts`
- LLMトレースは最小保持（本文は保存しない）
- hash + metadataのみ

8. `fact_claim_feedback`
- UI手動改訂/retractの監査履歴

## 抽出パイプライン（v2）
1. 入力保存 (`app_entries`)
2. `fact_documents` 生成/更新
3. PII判定
- high-risk: OpenAI送信ブロック (`blocked`)
- medium-risk: マスク送信
- low-risk: 通常送信
4. LLM Structured Output 抽出（`claim_schema_v2.py`）
5. 品質ゲート
- evidence欠落/意味不成立/object短すぎ を reject
6. 保存
- claims + evidence + dimensions + extractionログ
7. 失敗時
- フォールバック抽出は行わず `queued_retry` で記録

## API契約（v2）
- 解析実行: `POST /analysis/jobs`
- ジョブ参照: `GET /analysis/jobs`, `GET /analysis/jobs/:id`
- モデル取得: `GET /analysis/models`
- claim探索: `GET /facts/claims`, `GET /facts/claims/:id`, `GET /facts/by-entry/:entryId`
- 手動修正: `POST /facts/claims/:id/revise`, `POST /facts/claims/:id/retract`
- 圧縮サマリ: `GET /rollups`, `POST /rollups/rebuild`
- 互換: `POST /analysis/run` と `GET /facts/search` は同処理へ委譲

## Web構成（v2）
- `/` ホーム: 入力・一覧・解析実行
- `/analysis-history`: ジョブ履歴 + claim展開 + 再試行
- `/facts`: claim探索 + rollup表示
- `/facts/:claimId`: claim詳細 + 手動改訂/retract
- `/insights`: OpenAI利用量/コスト集計

## 実装ファイル
- `apps/worker/extract_claims_llm.py`
- `apps/worker/claim_schema_v2.py`
- `apps/worker/redaction.py`

## OpenAI利用ログ
- テーブル: `public.openai_api_requests`
- 主なキー:
  - `source_ref_type = entry`
  - `source_ref_id = <entry_id>`
  - token/cost/error を1リクエスト単位で保持
