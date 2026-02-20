# データモデル（DB正本）

## 設計方針
- まずは `日記 / 学び / 思考メモ / TODO` の4機能だけに絞る
- 入力は必ず `captures_raw` に残し、あとで再パースできるようにする
- 初期は過度な正規化を避け、運用負荷と入力摩擦を最小化する
- 将来拡張はテーブル追加で行い、既存データ構造を壊さない

## コア概念
- `captures_raw`: 未整理入力の受け皿（Inbox）
- `notes`: 日記・学び・思考メモを1テーブルで管理（`note_type`で区別）
- `tasks`: TODO管理（状態・優先度・期限）
- `tags` + `note_tags` + `task_tags`: 後から整理しやすくするための軽量タグ
- `note_links`: ノート同士の関連（関連/因果/フォローアップ）
- `audit_events`: 検索・閲覧・出力の監査ログ

## 推奨主キー
- すべて `UUIDv7`（時系列ソートしやすい）

## 最低限の必須カラム
- どのテーブルにも `created_at`, `updated_at`, `sensitivity` を付与
- `notes` には `note_type`, `occurred_at`, `summary`, `body`, `journal_date`
- `tasks` には `status`, `priority`, `due_at`, `done_at`

## 参照一貫性
- 削除は基本 `soft delete`（`deleted_at`）
- `captures_raw -> notes/tasks` の追跡を残す（再処理・監査用）
- `notes` と `tasks` は直接リンク可能（メモ起点のタスク生成を追える）

## 初期リリースで入れないもの
- 人物/場所/プロジェクトなどのエンティティ分離
- 意思決定専用テーブル
- 会話セッション・提案ログ
- メディア管理の詳細メタ

上記は Phase 2以降で、運用データが溜まってから追加する。

## ポータビリティ
- エクスポート形式を固定
  - `JSONL`: バックアップ/移行
  - `Markdown`: 人間可読メモ
  - `CSV`: 簡易分析
