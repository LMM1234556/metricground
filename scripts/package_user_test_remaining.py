"""Package original synthetic fixtures, never call models or edit source data."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "runtime" / "user-test-remaining-v0.3.10-20261012"
FIXTURES = {
    3: [ROOT / "evaluation/novice_test_files/novice_test_p03.xlsx"],
    4: [ROOT / "evaluation/novice_test_files/novice_test_p04.xlsx"],
    5: [ROOT / "evaluation/fixtures/join_orders_sample.csv",
        ROOT / "evaluation/fixtures/join_items_sample.csv"],
}

if OUTPUT.exists():
    raise SystemExit("Output exists; preserve existing packages and select a new directory.")
OUTPUT.mkdir(parents=True)
receipts = []
for number, fixtures in FIXTURES.items():
    brief = ROOT / "evaluation/user_test_remaining" / f"participant_p{number:02}.md"
    archive = OUTPUT / f"MetricGround-P{number:02}-test.zip"
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as package:
        for fixture in fixtures:
            package.write(fixture, fixture.name)
        package.write(brief, "测试说明.md")
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        assert set(package.namelist()) == {"测试说明.md", *(p.name for p in fixtures)}
        sources = []
        for fixture in fixtures:
            original_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
            assert hashlib.sha256(package.read(fixture.name)).hexdigest() == original_hash
            sources.append({"file": fixture.name, "sha256": original_hash})
    receipts.append({"package": str(archive), "sources": sources})
print(json.dumps({"status": "prepared_not_tested", "model_calls": 0,
                  "packages": receipts}, ensure_ascii=True, indent=2))
