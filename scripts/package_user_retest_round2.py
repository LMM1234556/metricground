"""Package unchanged synthetic Excel fixtures with retest instructions; no model calls."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime" / "user-retest-round2-v0.3.10"

if OUTPUT.exists():
    raise SystemExit("Retest output already exists; preserve it and choose a new output directory.")
OUTPUT.mkdir(parents=True)
receipts = []
for number in (1, 2):
    fixture = ROOT / "evaluation" / "novice_test_files" / f"novice_test_p{number:02}.xlsx"
    brief = ROOT / "evaluation" / "user_test_round2" / f"participant_p{number:02}.md"
    archive = OUTPUT / f"MetricGround-P{number:02}-retest.zip"
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as package:
        package.write(fixture, fixture.name)
        package.write(brief, "回测说明.md")
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        assert set(package.namelist()) == {fixture.name, "回测说明.md"}
        assert hashlib.sha256(package.read(fixture.name)).hexdigest() == hashlib.sha256(fixture.read_bytes()).hexdigest()
    receipts.append({"package": str(archive), "original_fixture_unchanged": True})
print(json.dumps({"packages": receipts, "participants_retested": None, "status": "prepared_not_tested", "model_calls": 0}, ensure_ascii=True, indent=2))
