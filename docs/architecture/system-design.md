# 実装具体案（DB中心）

## MVPスコープ（最初に実現すること）
- 日記
- TODO管理
- 学びメモ
- 思考メモ

この4つに直接効かない機能（会話セッション専用テーブルなど）は後段で追加する。

## 1. 技術選定（低コスト + ポータブル優先）
- DB（MVP）: `SQLite + WAL + FTS5`（無料、単一ファイル、移行しやすい）
- DB（拡張）: `PostgreSQL + pgvector`（同じ論理モデルを移植）
- API: `FastAPI`（入力チャネル統合、OpenAPIでI/F固定）
- CLI: `Typer`（クイックキャプチャと検索を共通APIで実装）
- 非同期処理: `RQ / simple cron worker`（まずは軽量）
- 音声認識: `faster-whisper`（ローカル運用可能）
- 埋め込み: 小型埋め込みモデル（ローカル or API切替可能）
- 秘匿管理: `age/sops` か `1Password/Vault` に外出し

## 2. 論理アーキテクチャ（MVP）
1. `Capture Layer`（CLI/スマホ/ブラウザ/音声）
2. `Ingestion Layer`（raw保存、機密検査、重複判定）
3. `Structuring Layer`（ノート分類、タグ付与、TODO抽出）
4. `Knowledge Store`（notes/tasks中心のDB正本）
5. `Retrieval Layer`（全文検索 + 類似検索 + フィルタ + ランキング）
6. `Assist Layer`（日次/週次ブリーフ、会話準備カード）
7. `Governance Layer`（監査、TTL、公開事故防止）

## Worker境界（置換前提）
- Workerは「DB入力 -> DB出力 + 結果JSON」の契約で固定する
- 結果JSONは `schemas/json/worker/*.result.schema.json` に準拠
- 冪等性はDB制約（unique partial index）で担保する
- 実装言語は可変（Python/Go/Rust）だが契約は不変

## 3. 入力フロー（後で整理できる設計）
### 共通仕様
- すべて一旦 `captures_raw` へ保存
- 保存時に `input_type`, `source`, `sensitivity`, `occurred_at` だけ最低限付与
- 本文は雑でも可（後段で分割/要約/抽出）

### チャネル別
- CLI: 最速入力。1行メモ + オプションタグ
- スマホ: ショートカット→Webhook→raw保存
- ブラウザ: URL + 選択テキスト + タイトルを投入
- 音声: 一時バッファでSTT、音声本体は原則破棄（設定で保持可）

## 4. 検索・参照の実装
### 検索方式
- レキシカル: FTS5（日本語はトークナイザ検討）
- セマンティック: 埋め込みベクトル検索
- ファクト検索: `key_facts` のSPO検索（subject/predicate/object）
- フィルタ: `note_type/status/tag/date/sensitivity`

### ランキング（初期）
`score = 0.35 * semantic + 0.25 * lexical + 0.20 * fact_match + 0.15 * recency + 0.05 * tag_overlap`

### 出力
- `Recall Card`: 3行要約 + 根拠リンク3件
- `Evidence List`: タイムスタンプ付き原文断片
- `Action Draft`: 次に言うべき一文候補

### AI向け参照順
1. `v_ai_key_facts` から高信頼事実を取得
2. `v_ai_memory_items` から該当ノート/タスク本文を補完
3. 足りないときのみ `captures_raw` を参照

## 5. 会話アシスト実装
1. 音声入力（または会議字幕）を 5〜10秒窓で受信
2. STTで逐次テキスト化
3. 論点/意図/不足情報を抽出
4. DBから関連ノート・完了タスク・学びログを検索
5. 返答案を短く生成（20〜60字を複数候補）
6. 安全フィルタで禁則情報をマスク
7. 会話後に「保存候補（要約/決定/宿題）」として確認提示

## 6. 安全設計
### データ分類
- `public`: 外部公開可
- `internal`: 自分用通常データ
- `sensitive`: 平文禁止、要約のみ保存
- `restricted`: メタデータのみ保存（実体は外部安全領域）

### 機密スキャナ
- ルールベース（電話/住所/APIキー/契約番号等）
- 閾値超えで `blocked` にして保存停止
- 自動リライト案（「要約化」「伏字化」）を提示

### 暗号化と分離
- センシティブ本文は暗号化ストアへ
- DBには `vault_ref` と最小要約だけ保持
- 監査ログに「誰が何を閲覧したか」を残す

### 公開事故防止
- Git pre-commit + CIでシークレット/PIIスキャン
- `exports/` は暗号化済みのみコミット許可
- 公開前チェックリストをPRテンプレに固定

### データ寿命（TTL）
- raw音声: 即時破棄（デフォルト）
- 生テキスト: 90日で要約のみ残すポリシー選択可
- センシティブ: 明示的保留フラグがなければ自動削除
