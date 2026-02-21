import sys
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
WORKER_DIR = ROOT / "apps/worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from claim_schema import ParsedClaim, ParsedClaimLink, ParsedClaimsOutput, ParsedEvidenceSpan  # noqa: E402
from extract_claims_llm import normalize_to_me_centric_claims  # noqa: E402


def _claim(subject: str, predicate: str, obj: str, certainty: float = 0.9) -> ParsedClaim:
    return ParsedClaim(
        subject_text=subject,
        predicate=predicate,
        object_text=obj,
        modality="fact",
        polarity="affirm",
        certainty=certainty,
        time_start_utc=None,
        time_end_utc=None,
        subject_entity_name=None,
        object_entity_name=None,
        evidence_spans=[ParsedEvidenceSpan(char_start=None, char_end=None, excerpt=obj[:120])],
    )


class MeCentricClaimNormalizationTest(unittest.TestCase):
    def test_keeps_me_claims_and_adds_decision_cause_link(self) -> None:
        parsed = ParsedClaimsOutput(
            claims=[
                _claim("私", "did", "同期とお台場で遊んだ"),
                _claim("weather", "happened", "雨が降った"),
                _claim("me", "ended", "即解散した"),
            ],
            entities=[],
            links=[],
        )
        out = normalize_to_me_centric_claims(
            parsed,
            raw_text="今日お台場で同期と遊んだら雨降ってきて即解散になった",
            declared_type="journal",
            occurred_at_utc="2026-02-22T00:00:00Z",
        )
        summaries = {(c.subject_text, c.predicate, c.object_text) for c in out.claims}
        self.assertIn(("me", "did", "同期とお台場で遊んだ"), summaries)
        self.assertIn(("me", "ended", "即解散した"), summaries)
        self.assertIn(("weather", "happened", "雨が降った"), summaries)

        caused_by_links = [
            link for link in out.links if link.relation_type == "caused_by"
        ]
        self.assertTrue(caused_by_links, "decision->cause link should exist")

    def test_generates_me_fallback_claim_when_no_me_related_claims(self) -> None:
        parsed = ParsedClaimsOutput(
            claims=[_claim("weather", "happened", "強い雨が降った")],
            entities=[],
            links=[],
        )
        out = normalize_to_me_centric_claims(
            parsed,
            raw_text="強い雨が降った",
            declared_type="journal",
            occurred_at_utc="2026-02-22T00:00:00Z",
        )
        self.assertGreaterEqual(len(out.claims), 1)
        self.assertEqual(out.claims[0].subject_text, "me")
        self.assertIn(out.claims[0].predicate, {"experienced", "mentions", "did"})

    def test_rewrites_links_after_filter(self) -> None:
        parsed = ParsedClaimsOutput(
            claims=[
                _claim("me", "did", "資料を送付した"),
                _claim("team", "happened", "会議が延期された"),
                _claim("me", "decided", "別日程で再調整した"),
            ],
            entities=[],
            links=[ParsedClaimLink(from_claim_index=2, to_claim_index=1, relation_type="caused_by", confidence=0.8)],
        )
        out = normalize_to_me_centric_claims(
            parsed,
            raw_text="会議延期のため別日程で再調整した",
            declared_type="meeting",
            occurred_at_utc="2026-02-22T00:00:00Z",
        )
        self.assertTrue(out.links)
        for link in out.links:
            self.assertGreaterEqual(link.from_claim_index, 0)
            self.assertGreaterEqual(link.to_claim_index, 0)
            self.assertLess(link.from_claim_index, len(out.claims))
            self.assertLess(link.to_claim_index, len(out.claims))

    def test_context_completion_for_fragmented_state_change(self) -> None:
        parsed = ParsedClaimsOutput(
            claims=[
                _claim("me", "experienced", "喉の調子が悪くなり"),
                _claim("me", "experienced", "土曜日はさらに悪化した"),
            ],
            entities=[],
            links=[],
        )
        out = normalize_to_me_centric_claims(
            parsed,
            raw_text="金曜から喉の調子が悪くなり、案の定土曜日はさらに悪化した",
            declared_type="journal",
            occurred_at_utc="2026-02-22T00:00:00Z",
        )
        self.assertEqual(len(out.claims), 2)
        self.assertIn("喉の調子", out.claims[1].object_text)
        self.assertIn("悪化", out.claims[1].object_text)

    def test_restores_source_language_and_then_completes_fragment(self) -> None:
        c1 = _claim("me", "experienced", "sore throat starting Friday")
        c2 = _claim("me", "experienced", "worsened on Saturday")
        c1 = ParsedClaim(
            **{
                **c1.__dict__,
                "evidence_spans": [ParsedEvidenceSpan(char_start=None, char_end=None, excerpt="金曜から喉の調子が悪くなり")],
            }
        )
        c2 = ParsedClaim(
            **{
                **c2.__dict__,
                "evidence_spans": [ParsedEvidenceSpan(char_start=None, char_end=None, excerpt="案の定土曜日はさらに悪化した")],
            }
        )
        parsed = ParsedClaimsOutput(claims=[c1, c2], entities=[], links=[])
        out = normalize_to_me_centric_claims(
            parsed,
            raw_text="バイブコーディング楽しくてずっと作業しちゃってたからか、金曜から喉の調子が悪くなり、案の定土曜日はさらに悪化した。",
            declared_type="journal",
            occurred_at_utc="2026-02-22T00:00:00Z",
        )
        self.assertIn("喉の調子", out.claims[0].object_text)
        self.assertIn("喉の調子", out.claims[1].object_text)
        self.assertIn("悪化", out.claims[1].object_text)


if __name__ == "__main__":
    unittest.main()
