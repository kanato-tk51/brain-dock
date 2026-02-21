# Neon 初期セットアップ

## 目的
`apps/cli/capture.py --backend neon` を動かすための初期DBを作る。

## 前提
- Neonプロジェクト作成済み
- 接続文字列（`postgresql://...`）を安全に保管できること

## 1. マイグレーション適用
Neon SQL Editor か `psql` で以下を実行する。

- `neon/migrations/20260221130000_initial_schema.sql`

例:

```bash
psql "$NEON_DATABASE_URL" -f neon/migrations/20260221130000_initial_schema.sql
```

## 1.5 Python依存導入
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. 環境変数設定

```bash
export NEON_DATABASE_URL="postgresql://<user>:<pass>@<host>/<db>?sslmode=require"
```

## 3. 投入テスト

```bash
python3 apps/cli/capture.py \
  --backend neon \
  "今日の学びメモ"
```

## 4. Worker実行テスト

```bash
python3 apps/worker/process_captures.py --backend neon --limit 200
python3 apps/worker/extract_key_facts.py --backend neon --source all --replace-existing
```

## 5. 動作確認SQL

```sql
select id, kind, detail, created_at
from sources
order by created_at desc
limit 10;

select id, input_type, raw_text, status, pii_score, created_at
from captures_raw
order by created_at desc
limit 20;
```

## 注意
- Neon 接続する CLI/worker には `psycopg` が必要。
  - `pip install -r requirements.txt`
