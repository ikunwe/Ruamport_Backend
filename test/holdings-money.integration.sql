-- Development database only, after 013. Requires an existing test auth user.
-- Real PostgreSQL numeric aggregation, isolation, duplicate and filter checks.
begin;
do $$
declare
  uid uuid;
  account text := 'money-test-' || gen_random_uuid()::text;
  doc uuid;
  pending uuid;
  item jsonb;
  result jsonb;
  position jsonb;
  amount jsonb;
  orders jsonb;
  idx integer := 0;
begin
  if public.investment_amount_summary('[]') <> '[]'::jsonb then raise exception 'Empty totals must be empty'; end if;
  orders := '[
    {"movement":"BUY","currency":"USD","assetType":"OFFSHORE_STOCK","totalAmount":{"foreign":0.1,"thb":3.5}},
    {"movement":"BUY","currency":"USD","assetType":"OFFSHORE_STOCK","totalAmount":{"foreign":0.2,"thb":7}},
    {"movement":"SELL","currency":"USD","assetType":"OFFSHORE_STOCK","totalAmount":{"foreign":0.4,"thb":14}},
    {"movement":"SWITCH_IN","currency":"THB","assetType":"MUTUAL_FUND","totalAmount":20},
    {"movement":"SWITCH_OUT","currency":"THB","assetType":"MUTUAL_FUND","totalAmount":5},
    {"movement":null,"currency":"USD","assetType":"OFFSHORE_STOCK","totalAmount":{"foreign":999,"thb":999}}
  ]';
  result := public.investment_amount_summary(orders);
  select value into amount from jsonb_array_elements(result) where value->>'currency' = 'USD';
  if (amount->>'totalBuy')::numeric is distinct from 0.3::numeric
    or (amount->>'totalSell')::numeric is distinct from 0.4::numeric
    or (amount->>'netBuySellCashFlow')::numeric is distinct from -0.1::numeric
    or (amount->>'orderCount')::int <> 3 then raise exception 'Wrong USD totals: %', amount; end if;
  select value into amount from jsonb_array_elements(result) where value->>'currency' = 'THB';
  if (amount->>'totalBuy')::numeric <> 10.5 or (amount->>'totalSell')::numeric <> 14
    or (amount->>'totalSwitchIn')::numeric <> 20 or (amount->>'totalSwitchOut')::numeric <> 5
    or (amount->>'orderCount')::int <> 5 then raise exception 'Wrong THB/switch totals: %', amount; end if;

  -- Missing/malformed amounts must not turn into zero or poison other currencies.
  result := public.investment_amount_summary(orders || '[{"movement":"BUY","currency":"USD","assetType":"OFFSHORE_STOCK","totalAmount":{"foreign":1,"thb":"bad"}}]'::jsonb);
  select value into amount from jsonb_array_elements(result) where value->>'currency' = 'THB';
  if amount->>'totalBuy' is not null or (amount->>'missingAmountCount')::int <> 1
    or (amount->>'isComplete')::boolean is distinct from false
    or amount->>'netBuySellCashFlow' is not null then raise exception 'Missing amount hidden: %', amount; end if;
  select value into amount from jsonb_array_elements(result) where value->>'currency' = 'USD';
  if (amount->>'totalBuy')::numeric <> 1.3 or (amount->>'isComplete')::boolean is distinct from true
    then raise exception 'Independent currency completeness failed'; end if;

  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account))) returning id into doc;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'PREVIEW',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account))) returning id into pending;
  for item in select value from jsonb_array_elements('[
    {"type":"BUY","units":1,"foreign":10,"thb":350},
    {"type":"SELL","units":1,"foreign":12,"thb":420},
    {"type":"BUY","units":1,"foreign":10,"thb":350,"duplicate":true},
    {"type":"REWARD","units":1,"foreign":999,"thb":999},
    {"type":"BUY","units":1,"foreign":777,"thb":777,"pending":true}
  ]'::jsonb) loop
    insert into public.investment_transactions(user_id, document_id, order_index, order_id,
      transaction_type, asset_name, currency, units, details, is_duplicate)
    values(uid, case when item->>'pending' = 'true' then pending else doc end, idx, 'TEST-'||idx,
      item->>'type', account, 'USD', (item->>'units')::numeric,
      jsonb_build_object('totalAmount', jsonb_build_object('foreign', item->'foreign', 'thb', item->'thb')),
      coalesce((item->>'duplicate')::boolean, false));
    idx := idx + 1;
  end loop;
  result := public.get_stock_holdings(uid, true);
  select value into position from jsonb_array_elements(result->'items') where value->>'accountNumber' = account;
  select value into amount from jsonb_array_elements(position->'amounts') where value->>'currency' = 'USD';
  if position is null or position->>'status' <> 'CLOSED' or amount is null
    or (amount->>'totalBuy')::numeric <> 10 or (amount->>'totalSell')::numeric <> 12
    or (amount->>'orderCount')::int <> 2 then raise exception 'Duplicate/pending/special order included: %', position; end if;
  if exists(select 1 from jsonb_array_elements(public.get_stock_holdings(uid, false)->'items') value
    where value->>'accountNumber' = account) then raise exception 'Closed item not hidden'; end if;
  if result->'moneyTotals' is distinct from public.get_stock_holdings(uid, false)->'moneyTotals'
    then raise exception 'Closing filter changed historical totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'moneyTotals' <> '[]'::jsonb
    then raise exception 'User isolation failed'; end if;
  raise notice 'Money totals checks passed; rolling back synthetic records';
end;
$$;
rollback;
