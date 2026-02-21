# Worker置換性と性能方針

## 目的
- 将来、Pythonワーカーを他言語（Go/Rust/TypeScript）へ安全に置換できるようにする
- 高性能化してもデータ意味を壊さない

## 置換の境界（Contract First）
ワーカーの責務は「入力テーブルを読んで、出力テーブルを書き、結果JSONを返す」に固定する。

### Job 1: `process_captures`
- Input: `captures_raw (status='new')`
- Output: `notes/tasks` + `captures_raw.status`
- 結果スキーマ: `schemas/json/worker/process_captures.result.schema.json`

### Job 2: `extract_key_facts`
- Input: `notes/tasks`
- Output: `key_facts`
- 結果スキーマ: `schemas/json/worker/extract_key_facts.result.schema.json`
- 抽出契約: `schemas/json/key_facts.schema.json`

## 冪等性ルール（必須）
- `notes.source_capture_id` は active unique
- `tasks.source_capture_id` は active unique
- `key_facts(note_id, subject, predicate, object_text)` は active unique
- `key_facts(task_id, subject, predicate, object_text)` は active unique
- ワーカーは重複時に失敗せずスキップする

## 性能改善ロードマップ
1. 現状（Python + SQLite）:
   - 1台ローカルで低コスト運用
2. 中期（並列化）:
   - ノートIDレンジで分割実行
   - バルクINSERT
3. 高負荷（言語置換）:
   - 同じContractを保ったままGo/Rustワーカーに移植
   - DBをPostgreSQLへ移行して並列ワーカー常駐

## 置換手順（安全）
1. 新言語ワーカーを `--dry-run` で結果JSON比較
2. 既存ワーカーと同一入力で `key_facts` 差分比較
3. 差分許容範囲を決めて段階切替
4. 切替後も旧ワーカーを一定期間残してロールバック可能にする

## 最低限の互換条件
- `contract_version` を維持
- 結果JSONがスキーマ準拠
- DB制約違反ゼロ
- 冪等再実行で行数が不必要に増えない

## 実装メモ
- `apps/worker/json_contract.py` で実行時に結果JSONを検証
- 各ワーカーは `print` 前に `validate_contract(...)` を必須化
