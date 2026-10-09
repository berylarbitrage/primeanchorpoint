# Bintique Liquidation — liquidation.bintique.com

弃货 (liquidation load) 管理系统。布局/风格与 pallet.bintique.com 一致。

核心思路：**每一拖弃货 = 一条记录 (Lot)**，记录
- **我们的成本**：货款 + 运费 + 人工/装卸 + 其他 → 总成本
- **一拖卖多少钱**：标价 / 实际成交价
- **卖给了谁**：买家、成交日期
- **赚了多少**：毛利、毛利率（自动计算）
- **收款情况**：已收 / 未收（待收款页面可一键收款）

## 页面
| 菜单 | 内容 |
|---|---|
| 总览 Dashboard | 在库拖数、库存成本、销售额、成本、毛利、毛利率、待收款；按年/月筛选；每月销售/成本/毛利图、买家/货源排行 |
| 弃货库存 Inventory | 所有批次，按状态 (在库/已挂售/已售/作废)、货源筛选；库龄；一键「卖出」；导出 CSV |
| 销售记录 Sales | 已售批次：卖给谁、成交价、成本、毛利、毛利率、收款状态；按买家/日期筛选；合计行；导出 CSV |
| 待收款 Receivables | 还没收齐钱的单子，账龄，一键收款 |
| 货源 Suppliers | 货从哪来；每个货源的进货拖数、花费、带来的毛利 |
| 买家 Customers | 卖给谁；每个买家的购买拖数、销售额、毛利、欠款 |
| 用户 / Backup | 管理员：账号管理、JSON 备份下载 |

中文 / English 切换。每条记录都有修改记录（谁、什么时候、改了什么）。

## 本地运行
```
npm install
npm start
```
打开 http://localhost:3000 ，默认账号 `admin` / `liquidation2026`（首次启动时创建，**上线前请设置 `ADMIN_PASS`**）。

## 部署到 Railway
1. 在 Railway 新建项目 → 连接本仓库
2. 添加 Volume，挂载路径 `/data`（SQLite 数据库存在这里）
3. 环境变量：`ADMIN_USER=admin`、`ADMIN_PASS=<强密码>`
4. Deploy

## 绑定域名 liquidation.bintique.com
Railway → Settings → Networking → Custom Domain → 填 `liquidation.bintique.com`，
然后在 bintique.com 的 DNS 里加一条 **CNAME**：`liquidation` → Railway 给出的目标地址。

## 技术
Node.js + Express + better-sqlite3，单页前端（`public/`），Chart.js 由服务器本地提供。
