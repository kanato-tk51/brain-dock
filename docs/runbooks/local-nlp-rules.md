# ローカルNLPルール改善 Runbook

## 目的
`process_captures` と `extract_key_facts` のルール抽出を、  
`SudachiPy + regex` のハイブリッドで運用し、定量評価で品質を監視する。

## 依存のインストール
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 実行フロー
```bash
# 1) captures_raw -> notes/tasks
python3 apps/worker/process_captures.py --backend neon --limit 200

# 2) notes/tasks -> key_facts (rules)
python3 apps/worker/extract_key_facts.py --backend neon --source all --replace-existing
```

1〜3段階を一気にテストする場合（データはデフォルトで残らない）:
```bash
python3 apps/cli/pipeline_test_run.py "今日の学びメモ"
```

SQLite の場合は `--backend sqlite --db ./brain_dock.db` を使う。

## ルール評価
ゴールドデータ:
- `tests/fixtures/gold/process_captures_labels.jsonl`（100件）
- `tests/fixtures/gold/key_facts_labels.jsonl`（100件）

評価:
```bash
python3 scripts/eval/eval_rules.py
python3 scripts/eval/eval_rules.py --enforce
```

しきい値（`--enforce`）:
- classification `macro_f1 >= 0.80`
- facts `predicate_precision >= 0.85`
- facts `duplicate_rate <= 0.05`

## フォールバック挙動
Sudachi が未導入・初期化失敗でも処理は停止しない。  
regex のみで継続する。

強制的にフォールバック確認する場合:
```bash
BRAIN_DOCK_DISABLE_SUDACHI=1 python3 apps/worker/process_captures.py --db ./brain_dock.db
```

## 監視ポイント
- worker JSON の `errors`
- `captures_blocked` の増減
- `facts_inserted / facts_skipped` 比率の急変
