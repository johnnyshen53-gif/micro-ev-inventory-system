-- 官網「優惠專區」用：未登入的訪客（anon）也能讀「進行中」的特惠組合。
--
-- 只回傳官網要顯示的欄位：組合名稱、期間、組合價、目前原價合計、內容（品名＋數量）。
-- 不回傳成本、庫存、建立者、組合 id 或品項 id；優惠代碼（coupons）完全不公開。
-- 「進行中」= 已啟用，且台北今天落在開始日～結束日之間（含頭尾兩天），與結帳時的判斷一致。
--
-- 為什麼用 security definer 而且放在 public：
--   promotions／items 這兩張表只開放給在職店員讀，訪客直接查會被 RLS 擋下；
--   這個函式以擁有者權限執行、但只吐出上面列的欄位，等於開一個「只能看、不能改」的小窗口。
--   不把 app_private 的使用權給 anon，避免其他內部函式被訪客看到。
create or replace function public.get_public_promotions()
returns table (
  name text,
  starts_on date,
  ends_on date,
  combo_price numeric,
  list_total numeric,
  items jsonb
)
language sql stable security definer set search_path = '' as $$
  select p.name, p.starts_on, p.ends_on, p.combo_price,
         sum(i.price * pi.quantity) as list_total,
         jsonb_agg(jsonb_build_object('name', i.name, 'quantity', pi.quantity) order by i.name) as items
  from public.promotions p
  join public.promotion_items pi on pi.promotion_id = p.id
  join public.items i on i.id = pi.item_id
  where p.active
    and (now() at time zone 'Asia/Taipei')::date between p.starts_on and p.ends_on
  group by p.id
  order by p.ends_on, p.name
  limit 50
$$;

revoke all on function public.get_public_promotions() from public;
grant execute on function public.get_public_promotions() to anon, authenticated;
