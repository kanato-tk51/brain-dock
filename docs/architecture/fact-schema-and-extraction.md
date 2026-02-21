# Fact-First 形式と抽出フロー（LLM一本化）

## 目的
Brain Dock を「忘れた事実を思い出すための外部記憶」として運用するため、
原文を保持しつつ `claim + evidence` を正本にする。

## 正本データモデル
- `fact_documents`
  - `entry/capture` の不変スナップショット
  - `raw_text`, `pii_score`, `redaction_state` を保持
- `fact_claims`
  - 1行1意味の事実
  - `subject_text`, `predicate`, `object_text`
  - `modality`（fact/plan/hypothesis/request/feeling）
  - `polarity`（affirm/negate）
  - `certainty`（0.0-1.0）
- `fact_evidence_spans`
  - claim の根拠断片と位置
  - `char_start`, `char_end`, `excerpt`
- `fact_entities`, `fact_entity_aliases`
  - 人物/場所/概念の正規化
- `fact_claim_links`
  - claim間関係（supports / contradicts / caused_by など）
- `fact_extraction_jobs`, `fact_extraction_job_items`
  - 手動解析トリガーの実行履歴・再試行管理

## 抽出フロー（現行）
1. UI入力を `app_entries + captures_raw` に保存
2. `fact_documents` を生成/更新
3. PII判定
  - high: 送信ブロック（job_item = blocked）
  - medium: 長さ維持マスクで送信
  - low: 原文送信
4. ChatGPT Structured Output で `claims/entities/links` を取得
5. DB保存
  - `fact_claims`
  - `fact_evidence_spans`
  - `fact_entities` / `fact_entity_aliases`
  - `fact_claim_links`
6. 失敗時は rules へフォールバックせず `queued` へ退避

## 実装ワーカー
- `apps/worker/extract_claims_llm.py`
- `apps/worker/claim_schema.py`
- `apps/worker/redaction.py`

### 実行例
```bash
python3 apps/worker/extract_claims_llm.py \
  --backend neon \
  --entry-id <entry-id> \
  --replace-existing
```

## OpenAI利用ログ
- テーブル: `public.openai_api_requests`
- 記録内容:
  - リクエスト時刻/モデル/トークン/推定コスト
  - `source_ref_type=entry`, `source_ref_id=<entry_id>`
  - エラー種別/エラーメッセージ

## 参照優先順位
1. `fact_claims`（構造化事実）
2. `fact_evidence_spans`（根拠）
3. `fact_documents.raw_text`（最終確認）
