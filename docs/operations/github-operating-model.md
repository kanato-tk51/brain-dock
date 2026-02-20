# GitHubでTODO/設計メモを蓄積する運用設計

## 1. 推奨フォルダ構成
- `docs/roadmap/`: フェーズ計画
- `docs/architecture/`: 技術設計・安全設計
- `docs/mvp/`: 直近実装計画
- `docs/plans/`: 全体統合計画
- `docs/operations/`: 運用ルール
- `design/adr/`: 意思決定記録(ADR)
- `notes/prompts/`: 重要プロンプト保存
- `schemas/sql/`: DBスキーマ
- `scripts/`: 移行・エクスポート・安全検査
- `exports/`: 監査用スナップショット（暗号化済み）

## 2. Issue / Projects 使い分け
### Issue
- `Feature`: 機能実装
- `Bug`: 挙動不具合
- `Research`: 技術調査
- `Security`: 安全改善/事故対応
- `Idea`: 未検証アイデア
- `Ops`: 運用改善

### GitHub Projects（単一ボード推奨）
- カラム: `Inbox` / `Ready` / `Doing` / `Review` / `Done` / `Parking`
- カスタム項目:
  - `Domain`（life/work/people/...）
  - `Phase`（phase0..phase6）
  - `Priority`（P0..P3）
  - `Risk`（low/medium/high/security）
  - `Effort`（S/M/L）
  - `Confidence`（0-100）

## 3. ラベル設計
ラベルは `.github/labels.yml` で管理し、CLIで同期する。

- `type:*` 機能種別
- `domain:*` 対象領域（people/place/task/health/...）
- `stage:*` 実装段階（mvp/beta/scale）
- `phase:*` ロードマップのフェーズ
- `risk:*` セキュリティ・プライバシー等
- `priority:*` 優先度
- `status:*` ブロック状態

## 4. テンプレート
- Issueテンプレ: Feature/Bug/Research/Security/Idea
- PRテンプレ:
  - 目的
  - 変更点
  - 安全確認（PII/秘密情報/公開可否）
  - テスト確認
  - 関連Issue
- ADRテンプレ: 背景/選択肢/決定/影響/見直し条件

## 5. “迷子にしない”バックログ運用
- ルール1: 思いつきは必ず `Idea Issue` 化
- ルール2: 週1回、`Idea -> Research/Feature` に昇格判定
- ルール3: 2週間触っていない `Doing` は `Parking` へ戻す
- ルール4: `Security` ラベルは通常Issueより優先
- ルール5: 各フェーズ終了時に ADR を最低1本残す

## 6. 設計メモ運用
- 3行メモでも `notes/` に残す（脳内だけに置かない）
- 仕様に昇格したら `docs/` へ移動
- 重要なプロンプトは `notes/prompts/` に保存
