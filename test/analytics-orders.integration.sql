begin;
do $$
declare uid uuid; doc uuid; data jsonb; old_data jsonb;
begin
  select id into uid from auth.users limit 1;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      '{"document":{"type":"DIME_OFFSHORE_CONFIRMATION_NOTE","accountNumber":"analytics-test"}}') returning id into doc;
  insert into public.investment_transactions(user_id, document_id, order_index, order_id,
    transaction_type, asset_name, currency, units, trade_date, details, is_duplicate)
    values(uid, doc, 0, 'AN1', 'BUY', 'ANALYTICS', 'USD', 1, '2026-10-01',
      '{"exchange":"XNYS","grossAmount":{"foreign":29.95,"thb":1000},"totalAmount":{"foreign":30,"thb":1002}}', false),
      (uid, doc, 1, 'AN2', 'BUY', 'ANALYTICS', 'USD', 1, '2026-10-02', '{}', false),
      (uid, doc, 2, 'AN3-DUP', 'BUY', 'ANALYTICS', 'USD', 1, '2026-10-03', '{"grossAmount":{"foreign":999}}', true);
  data := public.get_analytics_orders(uid);
  if not exists(select 1 from jsonb_array_elements(data->'orders') o where o @>
    '{"symbol":"ANALYTICS","exchange":"XNYS","flowAmount":29.95}'::jsonb)
    then raise exception 'Analytics must use native gross excluding fee, preserving PDF MIC'; end if;
  if not exists(select 1 from jsonb_array_elements(data->'orders') o where o->>'symbol' = 'ANALYTICS'
    and o->>'tradeDate' = '2026-10-02' and o->'flowAmount' = 'null'::jsonb)
    then raise exception 'Missing gross must stay null'; end if;
  if (select count(*) from jsonb_array_elements(data->'orders') o where o->>'symbol' = 'ANALYTICS') <> 2
    then raise exception 'Analytics included duplicate'; end if;
  if public.get_analytics_orders(gen_random_uuid())->'orders' <> '[]' then raise exception 'Analytics leaked across users'; end if;
  old_data := public.get_portfolio_history_orders(uid);
  if exists(select 1 from jsonb_array_elements(old_data->'orders') o where o ? 'flowAmount')
    then raise exception 'Old graph RPC was changed'; end if;
  update public.investment_documents set preview = '{"document":{"type":"DIME_MUTUAL_FUND_CONFIRMATION_NOTE"}}' where id = doc;
  update public.investment_transactions set details = '{"totalAmount":123.45,"feeIncludeVat":1.23}' where document_id = doc;
  data := public.get_analytics_orders(uid);
  if not exists(select 1 from jsonb_array_elements(data->'orders') o where o @> '{"symbol":"ANALYTICS","flowAmount":123.45}')
    then raise exception 'Fund flow must use totalAmount separate from fees'; end if;
  update public.investment_documents set preview = '{"document":{"type":"DIME_THAI_STOCK_CONFIRMATION_NOTE"}}' where id = doc;
  update public.investment_transactions set details = '{"grossAmount":55.55,"totalAmount":56}' where document_id = doc;
  data := public.get_analytics_orders(uid);
  if not exists(select 1 from jsonb_array_elements(data->'orders') o where o @> '{"symbol":"ANALYTICS","flowAmount":55.55}')
    then raise exception 'Thai stock flow must use gross'; end if;
  if has_function_privilege('authenticated', 'public.get_analytics_orders(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.get_analytics_orders(uuid)', 'EXECUTE')
    then raise exception 'Analytics RPC must remain service-role only'; end if;
end $$;
rollback;
