# brain-dock

個人ライフOSを長期運用するための設計・実装・運用リポジトリです。  
正本はDBに置き、GitHubは「設計・運用知識・実装コード・監査用スナップショット」の置き場として使います。

## 目的
- 忘れっぽさを補い、過去の経験を会話中に即参照できる状態を作る
- 入力摩擦を下げ、毎日継続できる個人知識基盤を作る
- 将来的に会話アシスト（リアルタイム提案）まで拡張する

## 原則
- `DB-first`: DBをsource of truthにする
- `Capture-first`: まず雑に投入、後で自動整理
- `Security-by-default`: センシティブ情報は平文で置かない
- `Portable`: エクスポートと移行可能性を常に確保する
- `Small steps`: 小さいMVPを積み上げる

## まず読むドキュメント
- ロードマップ: `docs/roadmap/phase-roadmap.md`
- 実装方式: `docs/architecture/system-design.md`
- データモデル: `docs/architecture/data-model.md`
- 事実抽出設計: `docs/architecture/fact-schema-and-extraction.md`
- 置換性/性能方針: `docs/architecture/worker-portability-and-performance.md`
- 4.x統合計画: `docs/plans/full-4x-integration.md`
- 実装バックログ（次にやること）: `docs/plans/implementation-backlog.md`
- GitHub運用: `docs/operations/github-operating-model.md`

## 実装済みジョブ
- `captures_raw` へのクイック入力:
  `python3 apps/cli/capture.py --db ./brain_dock.db "今日の学びメモ"`
- `captures_raw` へのクイック入力（Neon/PostgreSQL）:
  `NEON_DATABASE_URL=postgresql://... python3 apps/cli/capture.py --backend neon "ブラウザ経由メモ"`
- Neon 初期マイグレーション:
  `neon/migrations/20260221130000_initial_schema.sql`
- Web/API 用マイグレーション:
  `neon/migrations/20260221220000_web_api_tables.sql`
- `captures_raw -> notes/tasks` 変換:
  `python3 apps/worker/process_captures.py --db ./brain_dock.db`
- `captures_raw -> notes/tasks` 変換（Neon/PostgreSQL）:
  `NEON_DATABASE_URL=postgresql://... python3 apps/worker/process_captures.py --backend neon`
- `notes/tasks -> key_facts` 抽出（ルール）:
  `python3 apps/worker/extract_key_facts.py --db ./brain_dock.db --source all --replace-existing`
- `notes/tasks -> key_facts` 抽出（ルール / Neon/PostgreSQL）:
  `NEON_DATABASE_URL=postgresql://... python3 apps/worker/extract_key_facts.py --backend neon --source all --replace-existing`
- `notes/tasks -> key_facts` 抽出（LLM structured output）:
  `OPENAI_API_KEY=*** python3 apps/worker/extract_key_facts.py --db ./brain_dock.db --source all --replace-existing --extractor llm`
- `notes/tasks -> key_facts` 抽出（LLM structured output / Neon/PostgreSQL）:
  `NEON_DATABASE_URL=postgresql://... OPENAI_API_KEY=*** python3 apps/worker/extract_key_facts.py --backend neon --source all --replace-existing --extractor llm`
- 1〜3段階のローカル一括テスト（DBはデフォルトで残さない）:
  `python3 apps/cli/pipeline_test_run.py "今日の学びメモ"`

Neonセットアップ手順: `docs/runbooks/neon-setup.md`  
ローカルNLP改善・評価手順: `docs/runbooks/local-nlp-rules.md`

## ローカルNLP依存の導入
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Web UI (TypeScript, Next.js)
```bash
pnpm install
pnpm dev
```
Runbook: `docs/runbooks/web-ui-local-first.md`
`pnpm dev` は workspace 内の `apps/*` で `dev` スクリプトを並列実行するため、
現在は `apps/web` と `apps/api` が同時起動されます。

API単体起動:
```bash
pnpm api:dev
```

Repository切替（Web）:
```bash
# デフォルトは remote
# local | hybrid | remote
# NEXT_PUBLIC_REPOSITORY_MODE=remote
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
```

認証（2段階: メール/パスワード + メールコード）:
```bash
# Vercel上では認証必須（ローカルは自動バイパス）
BRAIN_DOCK_ALLOWED_EMAIL=k-takahashi@toggle.co.jp
NEXTAUTH_SECRET=...
BRAIN_DOCK_PASSWORD_BCRYPT=...
BRAIN_DOCK_SMTP_HOST=...
BRAIN_DOCK_SMTP_PORT=587
BRAIN_DOCK_SMTP_SECURE=0
BRAIN_DOCK_SMTP_USER=...
BRAIN_DOCK_SMTP_PASS=...
BRAIN_DOCK_SMTP_FROM=...
# 任意（秒、デフォルト300=5分）
# BRAIN_DOCK_EMAIL_OTP_TTL_SECONDS=300
# 任意: ローカルでも認証を強制したい場合
# BRAIN_DOCK_REQUIRE_AUTH=1
```

パスワードハッシュ生成例:
```bash
node -e "require('bcryptjs').hash(process.argv[1], 12).then(v=>console.log(v))" 'your-strong-password'
```

Vercelローカル事前ビルドチェック:
```bash
pnpm vercel-build
```

`pnpm vercel-build` は以下を順に実行:
- Neon migration (`pnpm db:migrate:neon` -> `apps/api/scripts/apply-neon-migrations.mjs`)
- Web build (`next build`)

環境変数込み(Production)で検証する場合（Vercel env pull + migration + build）:
```bash
pnpm vercel-build-with-env
```

主な画面:
- `/` Dashboard (timeline + search + filters + inline capture + OpenAI利用履歴/コスト集計)
- `/sync`
- `/lock`

OpenAI利用履歴API（Dashboardで利用）:
- `GET /openai/requests?fromUtc=&toUtc=&limit=&status=&model=&operation=&workflow=`
- `GET /openai/costs/summary?period=day|week|month&fromUtc=&toUtc=&limit=`

補足:
- `/capture` と `/capture/*` は `/` へリダイレクトされます。

## ルール評価（100件ゴールド）
```bash
python3 scripts/eval/eval_rules.py
python3 scripts/eval/eval_rules.py --enforce
```

## リポジトリ構成
- `apps/`: 実アプリ（CLI / API / UI）
- `packages/`: 共通ライブラリ（parser, ranking, policy等）
- `schemas/`: DBスキーマ、JSON Schema、migration
- `scripts/`: バックアップ、import/export、安全チェック
- `docs/`: 設計ドキュメント・運用ルール
- `design/adr/`: 意思決定記録(ADR)
- `notes/`: 設計メモ、プロンプト保存
- `exports/`: 監査用スナップショット（暗号化済みのみ）

## ディレクトリ早見表
```text
brain-dock/
├── README.md
├── .github/                 # Issue/PRテンプレ、ラベル
├── apps/                    # 実アプリ
│   ├── cli/
│   ├── api/
│   ├── worker/
│   └── web/
├── packages/                # 共通ライブラリ
├── schemas/                 # DB/JSONスキーマ
│   ├── sql/
│   └── json/
├── scripts/                 # 運用スクリプト
│   ├── migration/
│   ├── scan/
│   ├── backup/
│   └── export/
├── docs/                    # 仕様・設計・運用
│   ├── roadmap/
│   ├── architecture/
│   ├── mvp/
│   ├── operations/
│   ├── plans/
│   └── runbooks/
├── design/                  # ADR・設計補助資料
│   └── adr/
├── notes/                   # 生メモ・プロンプト保存
│   ├── inbox/
│   ├── prompts/
│   ├── weekly/
│   └── research/
├── exports/                 # 監査/移行用スナップショット
│   ├── snapshots/
│   └── audit/
└── tests/
```

## セキュリティ最低ルール
- APIキー、住所、電話番号、契約原本、顧客生データ、健康の詳細は平文禁止
- センシティブデータは `外部暗号化ストア + 要約メタデータ` を採用
- `pre-commit` とCIでシークレット/PIIスキャンを必須化
- 公開前に `exports/` と `notes/` を自動検査する

## 運用リズム
- 毎日: 1行キャプチャを続ける
- 毎週: Inboxトリアージ + 週次サマリ生成
- 毎月: ポリシー見直し + 保持期限ルール適用
