# Gold Fixtures

## `process_captures_labels.jsonl`
- 100件
- フィールド:
  - `id`
  - `input_type`
  - `text`
  - `expected_label` (`task|journal|learning|thought`)

## `key_facts_labels.jsonl`
- 100件
- フィールド:
  - `id`
  - `item_type` (`note|task`)
  - `text`
  - `expected.predicate`
  - `expected.object_contains`（部分一致）
