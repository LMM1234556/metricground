const FIELD_LABELS: Array<[RegExp, string]> = [
  [/^(order_id|订单编号)$/i, "订单编号"],
  [/^(customer_id|用户编号|客户编号)$/i, "客户编号"],
  [/^(customer_name|客户名称)$/i, "客户名称"],
  [/^(amount|order_amount|sales_amount|gmv|金额|订单金额)$/i, "订单金额"],
  [/^(order_date|purchase_date|created_at|订单日期|购买日期)$/i, "订单日期"],
  [/^(region|customer_region|客户地区|地区)$/i, "客户地区"],
  [/^(region_manager|区域负责人)$/i, "区域负责人"],
  [/^(market_tier|市场等级)$/i, "市场等级"],
  [/^(category|product_category|品类)$/i, "商品品类"],
  [/^(channel|sales_channel|渠道)$/i, "销售渠道"],
];

export function rawFieldName(fieldName: string) {
  return fieldName.split(".").at(-1) ?? fieldName;
}

export function businessFieldLabel(fieldName: string) {
  const raw = rawFieldName(fieldName);
  return FIELD_LABELS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw;
}

export function fieldDisplayName(fieldName: string) {
  const label = businessFieldLabel(fieldName);
  const raw = rawFieldName(fieldName);
  return label === raw ? fieldName : `${label}（${fieldName}）`;
}
