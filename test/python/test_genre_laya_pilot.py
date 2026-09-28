import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "genre-laya-pilot.py"
SPEC = importlib.util.spec_from_file_location("genre_laya_pilot", MODULE_PATH)
pilot = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(pilot)


def sample_case(kind="album"):
    return {
        "schemaVersion": pilot.SCHEMA,
        "caseId": f"{kind}:7", "kind": kind, "entityId": 7,
        "title": "Nombre que no es evidencia", "categories": ["external_suggestion"],
        "evidence": [{"ref": "assignment:9", "kind": "external_suggestion", "source": "discogs", "text": "Pop Rock"}],
        "candidates": [{"slug": "pop-rock", "name": "Pop rock", "family": "rock", "evidenceRefs": ["assignment:9"]}],
    }


class FakeRouter:
    def predict(self, state, questions, **kwargs):
        self.state, self.questions, self.kwargs = state, questions, kwargs
        return {
            "answers": {"principal": {"choice": "pop-rock", "probabilities": {
                "pop-rock": 0.8, pilot.ABSTAIN: 0.2,
            }}},
            "routing": {"model": "multilingual"},
        }


class GenreLayaPilotTests(unittest.TestCase):
    def test_album_rejects_artist_biography(self):
        case = sample_case()
        case["evidence"][0]["kind"] = "biography_claim"
        with self.assertRaisesRegex(ValueError, "álbum no puede usar"):
            pilot.validate_case(case)

    def test_album_accepts_corroborated_snapshot_reference(self):
        case = sample_case()
        case["evidence"][0] = {"ref": "snapshot:sincopa:abc:7", "kind": "genre_source_snapshot",
                               "source": "sincopa", "text": "Pop Rock"}
        case["candidates"][0]["evidenceRefs"] = ["snapshot:sincopa:abc:7"]
        pilot.validate_case(case)

    def test_choice_only_receives_evidence_and_returns_existing_refs(self):
        case = sample_case()
        router = FakeRouter()
        result = pilot.predict_one(router, case)
        self.assertEqual(result["primaryGenre"], "pop-rock")
        self.assertEqual(result["evidenceRefs"], ["assignment:9"])
        self.assertNotIn("title", router.state)
        self.assertNotIn("artist", router.state)
        self.assertEqual(router.kwargs["model"], "multilingual")
        self.assertIn(pilot.ABSTAIN, router.questions["principal"]["criteria"])

    def test_unreviewed_rows_do_not_count_as_accuracy(self):
        predictions = [{"caseId": "album:7", "primaryGenre": "pop-rock", "status": "suggested"}]
        gold = [{"caseId": "album:7", "reviewed": False, "primaryGenre": "pop-rock", "reviewer": ""}]
        self.assertEqual(pilot.score(predictions, gold)["comparable"], 0)
        gold[0]["reviewed"] = True
        gold[0]["reviewer"] = "herra:ana"
        self.assertEqual(pilot.score(predictions, gold)["accuracy"], 1.0)


if __name__ == "__main__":
    unittest.main()
