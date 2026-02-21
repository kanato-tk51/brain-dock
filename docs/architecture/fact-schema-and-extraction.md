# key_facts 形式と抽出フロー

## 目的
長文テキストをAIが即時参照しやすい「圧縮事実」に変換し、
リアルタイム検索と回答生成を安定させる。

## key_facts の最小形式
- `subject`: 主体（例: me, project-x, service-api）
- `predicate`: 関係/動詞（例: learned, decided, blocked_by, improved）
- `object_text`: 客体（例: retry with exponential backoff）
- `object_type`: text/number/date/bool/json
- `confidence`: 0.0-1.0
- `note_id` or `task_id`: 出典
- `evidence_excerpt`: 根拠断片

例:
- `(me, learned, retry with exponential backoff)`
- `(project-x, blocked_by, flaky integration test)`
- `(task:release-check, due_at, 2026-02-25)`

## 抽出フロー
1. `captures_raw` から `notes/tasks` に変換
2. `notes/tasks` の本文をAI抽出に投入
3. JSON Schemaで `key_facts[]` を強制出力
4. DBバリデーション
5. `confidence < 0.70` は保留キューへ
6. `confidence >= 0.70` のみ `key_facts` に保存

## 実装済みジョブ
- ファイル: `apps/worker/extract_key_facts.py`
- 方式: ルールベース抽出 + スキーマバリデーション + `confidence` 閾値保存

### 実行例
```bash
python3 apps/worker/extract_key_facts.py \
  --db ./brain_dock.db \
  --source all \
  --replace-existing
```

### 主要オプション
- `--source all|notes|tasks`
- `--all-rows`（変更分のみではなく全件再抽出）
- `--replace-existing`（既存factをsoft-deleteして再生成）
- `--min-confidence 0.70`
- `--dry-run`

## 抽出プロンプトのルール
- 推測で埋めない（不明はnull）
- 1ファクト1意味に分割する
- 時制/否定を落とさない
- 数値/日付は正規化
- 出典にない情報は禁止

## 参照順
1. `v_ai_key_facts`（高信頼の圧縮事実）
2. `v_ai_memory_items`（要約・本文補完）
3. 必要時のみ `captures_raw`

## 運用基準
- 同一ノートからの抽出件数目安: 3-12件
- confidence平均が0.75未満なら抽出器を見直す
- 週次で「誤抽出Top10」を確認し、抽出プロンプトを更新
