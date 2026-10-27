begin;
do $$
declare
  uid uuid; doc uuid; pending uuid; data jsonb;
begin
  select id into uid from auth.users limit 1;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      '{"document":{"type":"DIME_OFFSHORE_CONFIRMATION_NOTE","accountNumber":"history-test"}}') returning id into doc;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'PREVIEW',
      '{"document":{"type":"DIME_OFFSHORE_CONFIRMATION_NOTE"}}') returning id into pending;
  insert into public.investment_transactions(user_id, document_id, order_index, order_id,
    transaction_type, asset_name, currency, units, trade_date, details, is_duplicate)
    values(uid, doc, 0, 'H1', 'BUY', 'HISTORY', 'USD', 10, '2026-10-01', '{"exchange":"XNAS"}', false),
      (uid, doc, 1, 'H1-DUP', 'BUY', 'HISTORY', 'USD', 10, '2026-10-01', '{}', true),
      (uid, pending, 0, 'PENDING', 'BUY', 'HISTORY', 'USD', 999, '2026-10-01', '{}', false);
  data := public.get_portfolio_history_orders(uid);
  if not exists(select 1 from jsonb_array_elements(data->'orders') o where o @>
    '{"assetType":"OFFSHORE_STOCK","symbol":"HISTORY","accountNumber":"history-test","exchange":"XNAS","tradeDate":"2026-10-01","units":10}'::jsonb)
    then raise exception 'History input fields missing'; end if;
  if (select count(*) from jsonb_array_elements(data->'orders') o where o->>'symbol' = 'HISTORY') <> 1
    then raise exception 'History includes duplicate or preview'; end if;
  if public.get_portfolio_history_orders(gen_random_uuid())->'orders' <> '[]' then raise exception 'History input leaked across users'; end if;
end;
$$;
rollback;
