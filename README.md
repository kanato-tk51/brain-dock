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
- MVP(1〜2週間): `docs/mvp/mvp-1-2-weeks.md`
- 4.x統合計画: `docs/plans/full-4x-integration.md`
- GitHub運用: `docs/operations/github-operating-model.md`
- 今日のTODO: `docs/next-steps/today-start.md`

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
│   └── next-steps/
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
