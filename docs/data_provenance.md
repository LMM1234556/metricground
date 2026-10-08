# 数据来源与复算说明

## 来源

当前页面使用工作区 `archive` 目录中的 9 张 Olist 匿名历史 CSV。原始数据不会由前端修改；页面读取由复算脚本生成的只读 JSON 快照。

## 可复现流程

```powershell
.\.venv\Scripts\python.exe .\scripts\prepare_olist_snapshot.py
```

脚本将订单限制在 `2017-01-01 <= order_purchase_timestamp < 2018-09-01`，先把商品明细按 `order_id` 汇总至一行，再与订单和客户表连接，最终输出：

`frontend/app/data/olist_snapshot.json`

## 自动校验

- 订单主键是否重复；
- 订单商品复合键是否重复；
- 已送达订单是否均匹配商品明细；
- 购买时间是否缺失；
- 月度 GMV 合计是否与总体 GMV 对账。
- 全部品类 GMV 是否与总体 GMV 对账；
- 评价是否先聚合至一行一订单，差评率是否处于合理范围。

页面显示的校验状态直接来自该快照，不是手工填写的“通过”。
