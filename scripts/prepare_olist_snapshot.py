"""Build a reviewed, source-backed Olist snapshot for the MetricGround UI.

The script deliberately aggregates order items to one row per order before
joining them to orders. This prevents an order containing multiple products
from inflating order-level counts and averages.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = PROJECT_DIR.parents[1]
DEFAULT_SOURCE_DIR = Path(
    os.environ.get("OLIST_DATA_DIR", str(WORKSPACE_DIR / "archive"))
).expanduser()
DEFAULT_OUTPUT_PATH = PROJECT_DIR / "frontend" / "app" / "data" / "olist_snapshot.json"

START = pd.Timestamp("2017-01-01")
END_EXCLUSIVE = pd.Timestamp("2018-09-01")

FILES = {
    "orders": "olist_orders_dataset.csv",
    "items": "olist_order_items_dataset.csv",
    "customers": "olist_customers_dataset.csv",
    "payments": "olist_order_payments_dataset.csv",
    "reviews": "olist_order_reviews_dataset.csv",
    "products": "olist_products_dataset.csv",
    "sellers": "olist_sellers_dataset.csv",
    "geolocation": "olist_geolocation_dataset.csv",
    "category_translation": "product_category_name_translation.csv",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help="Directory containing the nine Olist CSV files.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Path for the generated frontend JSON snapshot.",
    )
    return parser.parse_args()


def require_sources(source_dir: Path) -> None:
    missing = [name for name in FILES.values() if not (source_dir / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing Olist source files: {', '.join(missing)}")


def csv_row_count(path: Path) -> int:
    with path.open("rb") as stream:
        return max(sum(1 for _ in stream) - 1, 0)


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.resolve()
    output_path = args.output.resolve()
    require_sources(source_dir)

    orders = pd.read_csv(
        source_dir / FILES["orders"],
        usecols=[
            "order_id",
            "customer_id",
            "order_status",
            "order_purchase_timestamp",
            "order_delivered_customer_date",
            "order_estimated_delivery_date",
        ],
        parse_dates=[
            "order_purchase_timestamp",
            "order_delivered_customer_date",
            "order_estimated_delivery_date",
        ],
    )
    items = pd.read_csv(
        source_dir / FILES["items"],
        usecols=["order_id", "order_item_id", "product_id", "price", "freight_value"],
    )
    customers = pd.read_csv(
        source_dir / FILES["customers"],
        usecols=["customer_id", "customer_unique_id"],
    )
    reviews = pd.read_csv(
        source_dir / FILES["reviews"],
        usecols=["order_id", "review_score"],
    )
    products = pd.read_csv(
        source_dir / FILES["products"],
        usecols=["product_id", "product_category_name"],
    )
    translations = pd.read_csv(source_dir / FILES["category_translation"])

    scoped_orders = orders.loc[
        orders["order_purchase_timestamp"].ge(START)
        & orders["order_purchase_timestamp"].lt(END_EXCLUSIVE)
    ].copy()
    scoped_orders["purchase_month"] = scoped_orders[
        "order_purchase_timestamp"
    ].dt.strftime("%Y-%m")

    item_by_order = (
        items.groupby("order_id", as_index=False)
        .agg(product_gmv=("price", "sum"), freight_charge=("freight_value", "sum"))
    )
    delivered = scoped_orders.loc[scoped_orders["order_status"].eq("delivered")].copy()
    delivered = delivered.merge(
        item_by_order,
        on="order_id",
        how="left",
        validate="one_to_one",
        indicator="item_join_status",
    ).merge(customers, on="customer_id", how="left", validate="many_to_one")

    total_orders = int(scoped_orders["order_id"].nunique())
    delivered_orders = int(delivered["order_id"].nunique())
    product_gmv = float(delivered["product_gmv"].sum())
    delivered_buyers = int(delivered["customer_unique_id"].nunique())
    average_order_value = product_gmv / delivered_orders
    delivery_days = (
        delivered["order_delivered_customer_date"]
        - delivered["order_purchase_timestamp"]
    ).dt.total_seconds() / 86400

    monthly_orders = (
        scoped_orders.groupby("purchase_month")["order_id"]
        .nunique()
        .rename("all_order_count")
    )
    monthly_delivered = (
        delivered.groupby("purchase_month")
        .agg(
            delivered_order_count=("order_id", "nunique"),
            product_gmv=("product_gmv", "sum"),
        )
        .join(monthly_orders, how="left")
        .reset_index()
        .sort_values("purchase_month")
    )
    monthly_rows = [
        {
            "month": row.purchase_month,
            "allOrders": int(row.all_order_count),
            "deliveredOrders": int(row.delivered_order_count),
            "productGmv": round(float(row.product_gmv), 2),
            "productGmvThousands": round(float(row.product_gmv) / 1000, 2),
        }
        for row in monthly_delivered.itertuples(index=False)
    ]

    delivered_items = items.merge(
        delivered[["order_id"]], on="order_id", how="inner", validate="many_to_one"
    )
    category_detail = (
        delivered_items.merge(
            products, on="product_id", how="left", validate="many_to_one"
        ).merge(
            translations,
            on="product_category_name",
            how="left",
            validate="many_to_one",
        )
    )
    category_detail["category"] = (
        category_detail["product_category_name_english"]
        .fillna(category_detail["product_category_name"])
        .fillna("unknown")
    )
    category_metrics = (
        category_detail.groupby("category", as_index=False)
        .agg(
            product_gmv=("price", "sum"),
            delivered_orders=("order_id", "nunique"),
            item_count=("order_item_id", "count"),
        )
        .sort_values(["product_gmv", "category"], ascending=[False, True])
    )
    category_metrics["gmv_share"] = category_metrics["product_gmv"] / product_gmv
    top_categories = [
        {
            "rank": rank,
            "category": row.category,
            "productGmv": round(float(row.product_gmv), 2),
            "gmvShare": round(float(row.gmv_share), 6),
            "deliveredOrders": int(row.delivered_orders),
            "itemCount": int(row.item_count),
        }
        for rank, row in enumerate(category_metrics.head(5).itertuples(index=False), 1)
    ]

    reviews["is_negative_review"] = reviews["review_score"].le(2).astype(int)
    review_by_order = reviews.groupby("order_id", as_index=False).agg(
        is_negative_review=("is_negative_review", "max"),
        review_record_count=("review_score", "count"),
    )
    reviewed_delivery = delivered.merge(
        review_by_order, on="order_id", how="inner", validate="one_to_one"
    ).dropna(
        subset=["order_delivered_customer_date", "order_estimated_delivery_date"]
    )
    reviewed_delivery["delivery_status"] = "按时或提前"
    reviewed_delivery.loc[
        reviewed_delivery["order_delivered_customer_date"]
        > reviewed_delivery["order_estimated_delivery_date"],
        "delivery_status",
    ] = "延迟送达"
    delivery_review_metrics = (
        reviewed_delivery.groupby("delivery_status", as_index=False)
        .agg(
            reviewed_orders=("order_id", "nunique"),
            negative_reviews=("is_negative_review", "sum"),
        )
    )
    delivery_review_metrics["negative_review_rate"] = (
        delivery_review_metrics["negative_reviews"]
        / delivery_review_metrics["reviewed_orders"]
    )
    delivery_review = [
        {
            "status": row.delivery_status,
            "reviewedOrders": int(row.reviewed_orders),
            "negativeReviews": int(row.negative_reviews),
            "negativeReviewRate": round(float(row.negative_review_rate), 6),
        }
        for row in delivery_review_metrics.sort_values(
            "negative_review_rate", ascending=False
        ).itertuples(index=False)
    ]
    late_rate = next(
        row["negativeReviewRate"] for row in delivery_review if row["status"] == "延迟送达"
    )
    on_time_rate = next(
        row["negativeReviewRate"] for row in delivery_review if row["status"] == "按时或提前"
    )

    source_files = []
    total_source_rows = 0
    for key, filename in FILES.items():
        rows = csv_row_count(source_dir / filename)
        total_source_rows += rows
        source_files.append({"id": key, "name": filename, "rows": rows})

    duplicate_order_ids = int(orders["order_id"].duplicated().sum())
    duplicate_item_keys = int(items.duplicated(["order_id", "order_item_id"]).sum())
    unmatched_delivered_items = int(delivered["item_join_status"].eq("left_only").sum())
    missing_purchase_timestamps = int(orders["order_purchase_timestamp"].isna().sum())
    monthly_gmv_reconciles = abs(
        sum(row["productGmv"] for row in monthly_rows) - round(product_gmv, 2)
    ) < 0.01
    category_gmv_reconciles = abs(
        float(category_metrics["product_gmv"].sum()) - product_gmv
    ) < 0.01
    delivery_review_is_unique = reviewed_delivery["order_id"].is_unique
    delivery_rates_are_valid = delivery_review_metrics[
        "negative_review_rate"
    ].between(0, 1).all()

    snapshot = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "name": "Olist Brazilian E-Commerce Public Dataset",
            "classification": "匿名历史演示数据，非实时经营数据",
            "files": source_files,
            "fileCount": len(source_files),
            "totalRows": total_source_rows,
        },
        "scope": {
            "start": "2017-01-01",
            "endInclusive": "2018-08-31",
            "endExclusive": "2018-09-01",
            "monthCount": len(monthly_rows),
            "limitation": "2018 年仅覆盖 1—8 月，不应直接与 2017 全年比较。",
        },
        "kpis": {
            "totalOrders": total_orders,
            "deliveredOrders": delivered_orders,
            "deliveredRate": round(delivered_orders / total_orders, 6),
            "deliveredBuyers": delivered_buyers,
            "productGmv": round(product_gmv, 2),
            "averageOrderValue": round(average_order_value, 2),
            "averageDeliveryDays": round(float(delivery_days.mean()), 2),
        },
        "monthly": monthly_rows,
        "topCategories": top_categories,
        "deliveryReview": {
            "groups": delivery_review,
            "rateGap": round(late_rate - on_time_rate, 6),
            "riskRatio": round(late_rate / on_time_rate, 4),
            "interpretationLimit": "观察性分组只能说明关联，不能单独证明配送延迟导致负面评价。",
        },
        "definitions": {
            "totalOrders": "范围内按 order_id 去重后的全部状态订单数。",
            "deliveredOrders": "范围内 order_status = delivered 的去重订单数。",
            "productGmv": "已送达订单的商品价格 price 合计，不含运费，不等于企业收入或利润。",
            "averageOrderValue": "商品 GMV ÷ 已送达订单量。",
            "categoryProductGmv": "按商品品类汇总已送达订单商品价格；一笔订单可能包含多个品类，各品类订单数不可相加。",
            "negativeReview": "同一订单只要存在一条 review_score <= 2 的评价，即标记为负面评价订单。",
            "lateDelivery": "实际送达时间晚于预计送达时间的已送达订单。",
        },
        "validation": [
            {
                "id": "orders-primary-key",
                "label": "订单主键重复检查",
                "passed": duplicate_order_ids == 0,
                "detail": f"重复 order_id：{duplicate_order_ids}",
            },
            {
                "id": "items-composite-key",
                "label": "订单商品复合键检查",
                "passed": duplicate_item_keys == 0,
                "detail": f"重复 order_id + order_item_id：{duplicate_item_keys}",
            },
            {
                "id": "delivered-item-join",
                "label": "已送达订单商品关联检查",
                "passed": unmatched_delivered_items == 0,
                "detail": f"未匹配商品明细的已送达订单：{unmatched_delivered_items}",
            },
            {
                "id": "purchase-time",
                "label": "购买时间完整性检查",
                "passed": missing_purchase_timestamps == 0,
                "detail": f"缺失购买时间：{missing_purchase_timestamps}",
            },
            {
                "id": "gmv-reconciliation",
                "label": "月度 GMV 与总额对账",
                "passed": monthly_gmv_reconciles,
                "detail": f"月度合计 R${sum(row['productGmv'] for row in monthly_rows):,.2f}",
            },
            {
                "id": "category-gmv-reconciliation",
                "label": "品类 GMV 与总额对账",
                "passed": bool(category_gmv_reconciles),
                "detail": f"全部品类合计 R${category_metrics['product_gmv'].sum():,.2f}",
            },
            {
                "id": "review-order-grain",
                "label": "评价聚合至订单粒度",
                "passed": bool(delivery_review_is_unique),
                "detail": f"纳入评价分析订单：{len(reviewed_delivery):,}",
            },
            {
                "id": "negative-review-rate-range",
                "label": "差评率取值范围检查",
                "passed": bool(delivery_rates_are_valid),
                "detail": "两组差评率均位于 0%—100%",
            },
        ],
        "query": {
            "id": "olist-core-kpis-v1",
            "language": "SQL",
            "readOnly": True,
            "text": """WITH item_by_order AS (\n  SELECT order_id, SUM(price) AS product_gmv\n  FROM order_items\n  GROUP BY order_id\n)\nSELECT\n  COUNT(DISTINCT o.order_id) AS delivered_orders,\n  SUM(i.product_gmv) AS product_gmv\nFROM orders o\nJOIN item_by_order i ON o.order_id = i.order_id\nWHERE o.order_status = 'delivered'\n  AND o.order_purchase_timestamp >= '2017-01-01'\n  AND o.order_purchase_timestamp < '2018-09-01';""",
        },
        "queries": {
            "category": {
                "id": "olist-category-gmv-v1",
                "language": "SQL",
                "readOnly": True,
                "text": """SELECT\n  COALESCE(t.product_category_name_english,\n           p.product_category_name, 'unknown') AS category_name,\n  COUNT(DISTINCT o.order_id) AS delivered_orders,\n  SUM(oi.price) AS product_gmv\nFROM orders o\nJOIN order_items oi ON o.order_id = oi.order_id\nJOIN products p ON oi.product_id = p.product_id\nLEFT JOIN category_translation t\n  ON p.product_category_name = t.product_category_name\nWHERE o.order_status = 'delivered'\n  AND o.order_purchase_timestamp >= '2017-01-01'\n  AND o.order_purchase_timestamp < '2018-09-01'\nGROUP BY category_name\nORDER BY product_gmv DESC\nLIMIT 5;""",
            },
            "delivery": {
                "id": "olist-delivery-review-v1",
                "language": "SQL",
                "readOnly": True,
                "text": """WITH review_by_order AS (\n  SELECT order_id,\n         MAX(review_score <= 2) AS is_negative\n  FROM order_reviews\n  GROUP BY order_id\n)\nSELECT\n  CASE WHEN order_delivered_customer_date\n             > order_estimated_delivery_date\n       THEN '延迟送达' ELSE '按时或提前' END AS status,\n  COUNT(DISTINCT o.order_id) AS reviewed_orders,\n  AVG(r.is_negative) AS negative_review_rate\nFROM orders o\nJOIN review_by_order r ON o.order_id = r.order_id\nWHERE o.order_status = 'delivered'\n  AND o.order_purchase_timestamp >= '2017-01-01'\n  AND o.order_purchase_timestamp < '2018-09-01'\n  AND o.order_delivered_customer_date IS NOT NULL\n  AND o.order_estimated_delivery_date IS NOT NULL\nGROUP BY status;""",
            },
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"Snapshot written: {output_path}")
    print(
        json.dumps(
            {
                "total_orders": total_orders,
                "delivered_orders": delivered_orders,
                "product_gmv": round(product_gmv, 2),
                "average_order_value": round(average_order_value, 2),
                "average_delivery_days": round(float(delivery_days.mean()), 2),
                "all_validation_passed": all(
                    check["passed"] for check in snapshot["validation"]
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
