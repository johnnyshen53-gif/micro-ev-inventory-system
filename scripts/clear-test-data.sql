-- 清除全部營業測試資料（一次性使用，正式營運後請勿執行）
--
-- 會清空：品項、品項成本、原廠序號、庫存異動、銷售、維修、報價、保固與送修案件、
--         進貨、客戶、供應商、操作紀錄，以及分紅紀錄、業務歸屬、「適用機車獎金的品項」勾選。
-- 會保留：登入帳號、店員名單、工時費率、分紅設定（獎金金額、百分比、受領業務員）。
--
-- 使用方式：先在終端機執行 bash scripts/backup-db.sh 備份，
--          再把本檔全部內容貼到 Supabase 後台 → SQL Editor → Run。
-- 全部在同一個交易裡：任何一步失敗就整個取消，不會只清一半。
-- 清單中沒有加 CASCADE：若有遺漏的關聯資料表，會直接報錯而不是偷偷多刪。

begin;

truncate table
  public.items,
  public.item_costs,
  public.inventory_serials,
  public.inventory_transactions,
  public.sales,
  public.sale_lines,
  public.repair_orders,
  public.repair_lines,
  public.quotations,
  public.quotation_lines,
  public.warranties,
  public.warranty_cases,
  public.purchases,
  public.purchase_lines,
  public.customers,
  public.suppliers,
  public.audit_logs,
  app_private.motorcycle_bonus_items,
  app_private.sale_bonus_records,
  app_private.repair_bonus_records,
  app_private.sale_salesperson_attributions;

-- 確認結果：每一列都應該是 0。
select 'items' as 資料表, count(*) as 筆數 from public.items
union all select 'sales', count(*) from public.sales
union all select 'repair_orders', count(*) from public.repair_orders
union all select 'quotations', count(*) from public.quotations
union all select 'warranties', count(*) from public.warranties
union all select 'purchases', count(*) from public.purchases
union all select 'customers', count(*) from public.customers
union all select 'suppliers', count(*) from public.suppliers;

commit;
