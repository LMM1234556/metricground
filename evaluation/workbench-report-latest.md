# MetricGround 通用工作台固定任务测评

- 数据集：销售订单、客户营销、库存运营
- 任务数：30
- 通过：30
- 失败：0
- 通过率：100.0%
- 参考实现：独立 pandas 脚本
- 产品实现：浏览器本地确定性引擎

> 这是项目自建的小规模功能回归集，只证明下列固定任务通过，不代表覆盖所有公司或所有表格。

| 任务 | 类别 | 结果 | 预期 | 实际 |
|---|---|---:|---:|---:|
| sales_orders-profile-rows | 数据理解 | 通过 | 11 | 11 |
| sales_orders-profile-columns | 数据理解 | 通过 | 5 | 5 |
| sales_orders-profile-missing | 数据理解 | 通过 | 2 | 2 |
| sales_orders-quality-1 | 质量检查 | 通过 | 完全重复 | 完全重复 |
| sales_orders-quality-2 | 质量检查 | 通过 | 无法识别 | 无法识别 |
| sales_orders-quality-3 | 质量检查 | 通过 | 统计异常值 | 统计异常值 |
| sales_orders-metric-count | 受控计算 | 通过 | 7 | 7 |
| sales_orders-metric-amount | 受控计算 | 通过 | 10849 | 10849 |
| sales_orders-metric-average | 受控计算 | 通过 | 1549.857142857143 | 1549.86 |
| sales_orders-metric-ratio | 受控计算 | 通过 | 0.42857142857142855 | 0.4286 |
| marketing_customers-profile-rows | 数据理解 | 通过 | 10 | 10 |
| marketing_customers-profile-columns | 数据理解 | 通过 | 6 | 6 |
| marketing_customers-profile-missing | 数据理解 | 通过 | 2 | 2 |
| marketing_customers-quality-1 | 质量检查 | 通过 | 完全重复 | 完全重复 |
| marketing_customers-quality-2 | 质量检查 | 通过 | 无法识别 | 无法识别 |
| marketing_customers-quality-3 | 质量检查 | 通过 | 统计异常值 | 统计异常值 |
| marketing_customers-metric-count | 受控计算 | 通过 | 6 | 6 |
| marketing_customers-metric-amount | 受控计算 | 通过 | 5950 | 5950 |
| marketing_customers-metric-average | 受控计算 | 通过 | 991.6666666666666 | 991.67 |
| marketing_customers-metric-ratio | 受控计算 | 通过 | 0.6666666666666666 | 0.6667000000000001 |
| inventory_operations-profile-rows | 数据理解 | 通过 | 10 | 10 |
| inventory_operations-profile-columns | 数据理解 | 通过 | 5 | 5 |
| inventory_operations-profile-missing | 数据理解 | 通过 | 2 | 2 |
| inventory_operations-quality-1 | 质量检查 | 通过 | 完全重复 | 完全重复 |
| inventory_operations-quality-2 | 质量检查 | 通过 | 无法识别 | 无法识别 |
| inventory_operations-quality-3 | 质量检查 | 通过 | 统计异常值 | 统计异常值 |
| inventory_operations-metric-count | 受控计算 | 通过 | 6 | 6 |
| inventory_operations-metric-amount | 受控计算 | 通过 | 1044 | 1044 |
| inventory_operations-metric-average | 受控计算 | 通过 | 174 | 174 |
| inventory_operations-metric-ratio | 受控计算 | 通过 | 0.5 | 0.5 |
