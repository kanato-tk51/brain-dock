#!/usr/bin/env python3
"""Rule lexicon for local hybrid classification and fact extraction."""

from __future__ import annotations


CLASSIFICATION_LEMMAS: dict[str, set[str]] = {
    "task": {
        "todo",
        "task",
        "next",
        "対応",
        "確認",
        "提出",
        "修正",
        "レビュー",
        "作成",
        "更新",
        "実行",
        "対応する",
        "やる",
        "やること",
        "宿題",
        "期限",
        "締切",
        "完了",
    },
    "journal": {
        "今日",
        "昨日",
        "朝",
        "夜",
        "日記",
        "振り返り",
        "体調",
        "気分",
        "睡眠",
        "mood",
        "energy",
        "diary",
        "journal",
    },
    "learning": {
        "学ぶ",
        "学び",
        "学ん",
        "学習",
        "気づく",
        "理解",
        "記事",
        "動画",
        "本",
        "読書",
        "lesson",
        "learn",
        "insight",
        "knowledge",
        "調べる",
    },
    "thought": {
        "考え",
        "思考",
        "悩み",
        "仮説",
        "不安",
        "why",
        "how",
        "idea",
        "should",
        "疑問",
        "メモ",
        "方針",
    },
}


TIME_HINT_LEMMAS: set[str] = {
    "今日",
    "昨日",
    "明日",
    "朝",
    "夜",
    "今朝",
}


ACTION_HINT_LEMMAS: set[str] = {
    "する",
    "やる",
    "対応",
    "確認",
    "提出",
    "更新",
    "作成",
    "送る",
    "fix",
    "review",
}


PREDICATE_LEMMA_HINTS: dict[str, set[str]] = {
    "learned": {"学ぶ", "学び", "学ん", "学習", "理解", "気づく", "learn", "insight"},
    "decided": {"決める", "決定", "選ぶ", "choose", "decide"},
    "blocked_by": {"課題", "問題", "詰まる", "障害", "困る", "blocked", "不足"},
    "improved": {"改善", "効率化", "最適化", "最適", "良くなる", "improve", "optimize"},
    "next_action": {"次", "todo", "やる", "対応", "next", "will", "明日", "次回", "予定"},
    "tested": {"試す", "試験", "実験", "検証", "テスト", "実施", "experiment", "test"},
    "felt": {
        "感じる",
        "疲れる",
        "つらい",
        "嬉しい",
        "楽しい",
        "不安",
        "安心",
        "緊張",
        "落ち込む",
        "モヤモヤ",
        "feel",
    },
}


OBJECT_STOP_LEMMAS: set[str] = {
    "する",
    "なる",
    "ある",
    "いる",
    "こと",
    "もの",
    "これ",
    "それ",
    "ため",
    "です",
    "ます",
    "todo",
    "next",
}
