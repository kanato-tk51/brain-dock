# 4.x 全機能を実現する統合計画

## 依存関係の骨格
1. 入力基盤（4-1）
2. 自動整理（4-2）
3. 検索参照（4-3）
4. 提示/会話アシスト（4-4）
5. 自動運転・意思決定（4-5, 4-6, 4-13）
6. ドメイン拡張（4-7, 4-8, 4-9, 4-10, 4-14）
7. 分析（4-11, 4-15）
8. 常時安全（4-12）

## 段階ごとの追加コンポーネント

### Stage A: Capture Core
- コンポーネント: CLI, Webhook, raw store
- リスク: 入力が続かない
- 対策: 入力項目を4つ以内に固定

### Stage B: Structuring Core
- コンポーネント: 分類器、エンティティ抽出、alias辞書
- リスク: 誤分類
- 対策: 自動確定ではなく「提案->承認」導線

### Stage C: Retrieval Core
- コンポーネント: FTS、埋め込み検索、ランキング
- リスク: ノイズが多い
- 対策: domain/period/peopleフィルタと根拠表示

### Stage D: Assist Core
- コンポーネント: 会話理解、提案生成、安全フィルタ
- リスク: 不適切提案、過剰な情報提示
- 対策: 禁則ルール + 短文制限 + 根拠リンク必須

### Stage E: Automation Core
- コンポーネント: 日次/週次バッチ、目標進捗推定、習慣提案
- リスク: 通知疲れ
- 対策: 1日1回ブリーフ + 重要度しきい値

### Stage F: Domain Packs
- 仕事/人間関係/旅行/健康などをモジュールとして追加
- リスク: センシティブ混入
- 対策: ドメイン別ポリシー（health/finance厳格化）

### Stage G: Analytics
- コンポーネント: 集計、傾向推定、可視化
- リスク: 過剰解釈
- 対策: 因果ではなく相関表示、注意文を固定表示

## 全体アーキテクチャ（最終像）
- `Input Adapters`: CLI / Mobile / Browser / Voice / Integrations
- `Knowledge Engine`: Ingestion / Structuring / Retrieval / Policy
- `Assist Engine`: Conversation Assist / Daily Brief / Review Copilot
- `Governance Engine`: Security Scan / Encryption / Audit / TTL / Export
- `Surfaces`: CLI, VS Code拡張, Chromeサイドパネル, Bot, Menuアプリ

## 安全配慮（段階共通）
- 標準保存ポリシー: 要約優先、原文最小
- 音声: デフォルト非保存
- health/finance: 集計中心・詳細禁止
- 公開境界: private repo + CI guard + encrypted export
