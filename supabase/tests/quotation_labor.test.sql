begin;
insert into auth.users(id,email) values
  ('72000000-0000-4000-8000-000000000001','quote-admin@example.invalid'),
  ('72000000-0000-4000-8000-000000000002','quote-staff@example.invalid');
update public.profiles set role='admin',active=true where id='72000000-0000-4000-8000-000000000001';
update public.profiles set active=true where id='72000000-0000-4000-8000-000000000002';
insert into auth.sessions(id,user_id) values
  ('72000000-0000-4000-8000-000000000011','72000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000012','72000000-0000-4000-8000-000000000002');
insert into public.customers(id,member_number,name,phone,created_by) values
  ('72000000-0000-4000-8000-000000000021','M720001','測試客','0911000000','72000000-0000-4000-8000-000000000001');
insert into public.items(id,name,category,sku,price,stock,created_by) values
  ('72000000-0000-4000-8000-000000000031','煞車皮','零件','Q-LABOR',350,5,'72000000-0000-4000-8000-000000000001');

do $$ begin
  if to_regclass('public.shop_settings') is null then raise exception 'shop rate settings missing'; end if;
  if has_table_privilege('anon','public.shop_settings','SELECT,UPDATE') then raise exception 'anonymous users can access shop rate'; end if;
  if not (select relrowsecurity from pg_class where oid='public.shop_settings'::regclass) then raise exception 'shop rate RLS missing'; end if;
end $$;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"72000000-0000-4000-8000-000000000001","session_id":"72000000-0000-4000-8000-000000000011"}',true);
set local role authenticated;
update public.shop_settings set hourly_rate=800 where id=1;
reset role;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"72000000-0000-4000-8000-000000000002","session_id":"72000000-0000-4000-8000-000000000012"}',true);
set local role authenticated;
do $$
declare
  v_id uuid := '72000000-0000-4000-8000-000000000041';
  v_denied boolean := false;
begin
  update public.shop_settings set hourly_rate=1 where id=1;
  if (select hourly_rate from public.shop_settings where id=1) <> 800 then raise exception 'staff changed the shop rate'; end if;
  begin
    insert into public.quotations(id,quote_number,customer_id,total,created_by)
      values ('72000000-0000-4000-8000-000000000049','Q-BYPASS','72000000-0000-4000-8000-000000000021',1,auth.uid());
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'staff bypassed quote price validation through direct insert'; end if;
  v_denied := false;
  perform public.save_quotation(
    jsonb_build_object('id',v_id,'number','Q-LABOR-1','customerId','72000000-0000-4000-8000-000000000021','total',1900),
    jsonb_build_array(jsonb_build_object('itemId','72000000-0000-4000-8000-000000000031','itemName','煞車皮','quantity',2,'unitPrice',350,
      'installationRequired',true,'laborHours',1.5,'hourlyRate',800,'laborAmount',1200)));
  if (select total from public.quotations where id=v_id) <> 1900
    or (select subtotal from public.quotation_lines where quotation_id=v_id) <> 700
    or (select labor_amount from public.quotation_lines where quotation_id=v_id) <> 1200 then
    raise exception 'quote did not save material and labor snapshots'; end if;
  begin
    perform public.save_quotation(
      jsonb_build_object('id','72000000-0000-4000-8000-000000000042','number','Q-LABOR-2','customerId','72000000-0000-4000-8000-000000000021','total',1900),
      jsonb_build_array(jsonb_build_object('itemId','72000000-0000-4000-8000-000000000031','itemName','煞車皮','quantity',2,'unitPrice',350,
        'installationRequired',true,'laborHours',1.5,'hourlyRate',1,'laborAmount',1200)));
  exception when others then v_denied := true; end;
  if not v_denied or exists (select 1 from public.quotations where quote_number='Q-LABOR-2') then
    raise exception 'client price override accepted'; end if;
  v_denied := false;
  begin
    perform public.save_quotation(
      jsonb_build_object('id','72000000-0000-4000-8000-000000000043','number','Q-LABOR-3','customerId','72000000-0000-4000-8000-000000000021','total',1334),
      jsonb_build_array(jsonb_build_object('itemId','72000000-0000-4000-8000-000000000031','itemName','煞車皮','quantity',1,'unitPrice',350,
        'installationRequired',true,'laborHours',1.234,'hourlyRate',800,'laborAmount',984)));
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'more than two decimal labor hours accepted'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"72000000-0000-4000-8000-000000000001","session_id":"72000000-0000-4000-8000-000000000011"}',true);
set local role authenticated;
update public.shop_settings set hourly_rate=900 where id=1;
do $$ begin
  if (select total from public.quotations where quote_number='Q-LABOR-1') <> 1900
    or (select hourly_rate from public.quotation_lines where quotation_id='72000000-0000-4000-8000-000000000041') <> 800 then
    raise exception 'old quote changed after shop rate update'; end if;
end $$;
reset role;
rollback;
