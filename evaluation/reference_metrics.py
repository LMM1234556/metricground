"""Independent pandas reference for MetricGround's three fixed workbook fixtures."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"


def clean_frame(path: Path, required: list[str], date_field: str) -> pd.DataFrame:
    frame = pd.read_csv(path, dtype=str, keep_default_na=True)
    frame = frame.drop_duplicates(keep="first")
    frame = frame.dropna(subset=required)
    parsed = pd.to_datetime(frame[date_field], format="mixed", errors="coerce")
    frame = frame.loc[parsed.notna()].copy()
    return frame


def metric_set(
    frame: pd.DataFrame,
    entity: str,
    value: str,
    ratio_field: str,
    ratio_value: str,
) -> dict[str, float]:
    numeric = pd.to_numeric(frame[value], errors="coerce")
    entity_count = int(frame[entity].nunique(dropna=True))
    numerator = int(frame.loc[frame[ratio_field].eq(ratio_value), entity].nunique(dropna=True))
    return {
        "count": entity_count,
        "amount": float(numeric.sum()),
        "average": float(numeric.sum() / entity_count),
        "ratio": float(numerator / entity_count),
    }


datasets = {
    "sales_orders": {
        "file": "orders_quality_sample.csv",
        "frame": clean_frame(
            FIXTURES / "orders_quality_sample.csv",
            ["customer_id", "region"],
            "purchase_date",
        ),
        "entity": "order_id",
        "value": "amount",
        "ratio_field": "region",
        "ratio_value": "华东",
    },
    "marketing_customers": {
        "file": "marketing_customers_sample.csv",
        "frame": clean_frame(
            FIXTURES / "marketing_customers_sample.csv",
            ["exposed", "segment"],
            "signup_date",
        ),
        "entity": "customer_id",
        "value": "spend",
        "ratio_field": "exposed",
        "ratio_value": "1",
    },
    "inventory_operations": {
        "file": "inventory_operations_sample.csv",
        "frame": clean_frame(
            FIXTURES / "inventory_operations_sample.csv",
            ["stock_qty", "warehouse"],
            "snapshot_date",
        ),
        "entity": "sku",
        "value": "stock_qty",
        "ratio_field": "warehouse",
        "ratio_value": "WH-2",
    },
}

output = {}
for name, config in datasets.items():
    frame = config.pop("frame")
    output[name] = {
        "file": config["file"],
        "cleaned_rows": int(len(frame)),
        "metrics": metric_set(
            frame,
            config["entity"],
            config["value"],
            config["ratio_field"],
            config["ratio_value"],
        ),
    }

(ROOT / "reference_metrics.json").write_text(
    json.dumps(output, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(json.dumps(output, ensure_ascii=False, indent=2))
