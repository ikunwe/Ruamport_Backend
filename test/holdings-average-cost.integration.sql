-- Development PostgreSQL/Supabase, after 015. Pure cases plus real RPC fixtures.
-- Requires an existing development auth user. Every fixture rolls back.
begin;
do $$
declare
  orders jsonb := '[
    {"tradeDate":"2000-01-01","movement":"BUY","units":10,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":100,"thb":3500}},
    {"tradeDate":"2000-01-02","movement":"BUY","units":10,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":140,"thb":5040}},
    {"tradeDate":"2000-01-03","movement":"SELL","units":5,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":999,"thb":99999}}
  ]';
  result jsonb;
  row_value jsonb;
  bad jsonb;
begin
  result := public.investment_average_cost(orders, 'USD', 15, 15, 0.0000003);
  if not (result @> '{"status":"CALCULATED","averageCostPerUnit":12,"remainingCost":180,"rawRemainingCost":180}'::jsonb)
    then raise exception 'Weighted average/partial sale incorrect: %', result; end if;
  result := public.investment_average_cost(orders, 'THB', 15, 15, 0.0000003);
  if not (result @> '{"averageCostPerUnit":427,"remainingCost":6405}'::jsonb)
    then raise exception 'THB did not use independent historical gross: %', result; end if;
  -- Import order and sales proceeds/fees do not change cost.
  select jsonb_agg(value order by ord desc) into bad from jsonb_array_elements(orders) with ordinality e(value, ord);
  if public.investment_average_cost(bad, 'USD', 15, 15, 0.0000003)
    is distinct from public.investment_average_cost(orders, 'USD', 15, 15, 0.0000003)
    then raise exception 'Cost depends on upload order'; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"BUY","units":5,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":100}}]'::jsonb, 'USD', 20, 20, 0.0000003);
  if not (result @> '{"averageCostPerUnit":14,"remainingCost":280}'::jsonb)
    then raise exception 'Buy after partial sale incorrect: %', result; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":15}]'::jsonb, 'USD', 0, 0, 0.0000003);
  if not (result @> '{"status":"CALCULATED","averageCostPerUnit":null,"remainingCost":0}'::jsonb)
    then raise exception 'Full sale must clear cost: %', result; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":15},{"tradeDate":"2000-01-05","movement":"BUY","units":2,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":50}}]'::jsonb, 'USD', 2, 2, 0.0000003);
  if not (result @> '{"averageCostPerUnit":25,"remainingCost":50}'::jsonb)
    then raise exception 'New cycle retained old average'; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":15.0000002}]'::jsonb, 'USD', -0.0000002, 0, 0.0000003);
  if not (result @> '{"status":"CALCULATED","remainingCost":0,"rawRemainingCost":-0.0000024,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Tiny negative raw cost not preserved: %', result; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":14.9999998}]'::jsonb, 'USD', 0.0000002, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"rawRemainingCost":0.0000024,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Tiny positive raw cost not preserved: %', result; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":15.0000002},{"tradeDate":"2000-01-05","movement":"BUY","units":2,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":50}}]'::jsonb, 'USD', 1.9999998, 1.9999998, 0.0000003);
  if not (result @> '{"status":"CALCULATED","averageCostPerUnit":25,"remainingCost":49.999995,"rawRemainingCost":50,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Reopened tiny oversale corrupted new average: %', result; end if;
  result := public.investment_average_cost(orders, 'USD', 14, 14, 0.0000003);
  if not (result @> '{"status":"INCOMPLETE","issues":["COST_QUANTITY_MISMATCH"]}'::jsonb)
    then raise exception 'Unexpected holdings quantity accepted'; end if;
  result := public.investment_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":15.0000005}]'::jsonb, 'USD', -0.0000005, -0.0000005, 0.0000003);
  if not (result @> '{"status":"INCOMPLETE","remainingCost":null,"issues":["SELL_EXCEEDS_AVAILABLE_UNITS"]}'::jsonb)
    then raise exception 'Large oversale not rejected: %', result; end if;
  -- Earlier sale is not repaired by importing a later buy.
  result := public.investment_average_cost('[{"tradeDate":"2000-01-01","movement":"SELL","units":1},{"tradeDate":"2000-01-02","movement":"BUY","units":2,"grossAmount":20}]', 'THB', 1, 1, null);
  if not (result @> '{"status":"INCOMPLETE","issues":["SELL_EXCEEDS_AVAILABLE_UNITS"]}'::jsonb)
    then raise exception 'Oversale hidden by subsequent buy'; end if;
  for bad in select value from jsonb_array_elements('[
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1}],"issue":"BUY_GROSS_REQUIRED"},
    {"orders":[{"movement":"BUY","units":1,"grossAmount":10}],"issue":"TRADE_DATE_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":0,"grossAmount":10}],"issue":"INVALID_COST_UNITS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":-10}],"issue":"INVALID_BUY_GROSS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SWITCH_IN","units":1,"grossAmount":10}],"issue":"UNSUPPORTED_COST_TRANSACTION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":10,"collision":true}],"issue":"ORDER_ID_COLLISION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":2,"grossAmount":10},{"tradeDate":"2000-01-01","movement":"SELL","units":1}],"issue":"INTRADAY_ORDER_AMBIGUOUS"}
  ]'::jsonb) loop
    result := public.investment_average_cost(bad->'orders', 'THB', 1, 1, null);
    if result->>'status' <> 'INCOMPLETE' or result->>'remainingCost' is not null
      or not ((result->'issues') ? (bad->>'issue')) then raise exception 'Unsafe case not detected: %, %', bad, result; end if;
  end loop;
  -- Gross missing in THB need not invalidate the native currency, nor vice versa.
  result := public.investment_average_cost('[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":10}}]', 'USD', 1, 1, null);
  if (result->>'remainingCost')::numeric <> 10 then raise exception 'Independent USD cost failed'; end if;
  result := public.investment_average_cost('[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"assetType":"OFFSHORE_STOCK","grossAmount":{"foreign":10}}]', 'THB', 1, 1, null);
  if result->>'status' <> 'INCOMPLETE' then raise exception 'Missing THB was fabricated'; end if;
  result := public.investment_remaining_cost_totals('[{"currency":"USD","status":"CALCULATED","remainingCost":180},{"currency":"USD","status":"CALCULATED","remainingCost":50},{"currency":"THB","status":"INCOMPLETE","remainingCost":null}]');
  if not (result @> '[{"currency":"USD","remainingCost":230,"isComplete":true},{"currency":"THB","remainingCost":null,"isComplete":false,"incompletePositionCount":1}]'::jsonb)
    then raise exception 'Portfolio cost totals hid an incomplete position: %', result; end if;
end;
$$;

do $$
declare
  uid uuid;
  account text := 'cost-test-' || gen_random_uuid()::text;
  doc uuid;
  pending uuid;
  item jsonb;
  result jsonb;
  position jsonb;
  basis jsonb;
  idx integer := 0;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account))) returning id into doc;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'PREVIEW',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account))) returning id into pending;
  -- Deliberately reverse import order; cost must use trade_date, not created_at.
  for item in select value from jsonb_array_elements('[
    {"type":"SELL","units":5,"date":"2000-01-03","usd":999,"thb":99999},
    {"type":"BUY","units":10,"date":"2000-01-02","usd":140,"thb":5040},
    {"type":"BUY","units":10,"date":"2000-01-01","usd":100,"thb":3500},
    {"type":"BUY","units":10,"date":"2000-01-01","usd":100,"thb":3500,"duplicate":true},
    {"type":"BUY","units":999,"date":"2000-01-04","usd":999,"thb":999,"pending":true}
  ]'::jsonb) loop
    insert into public.investment_transactions(user_id, document_id, order_index, order_id,
      transaction_type, asset_name, currency, units, trade_date, details, is_duplicate)
    values(uid, case when item->>'pending' = 'true' then pending else doc end, idx, 'TEST-'||idx,
      item->>'type', account, 'USD', (item->>'units')::numeric, (item->>'date')::date,
      jsonb_build_object('grossAmount', jsonb_build_object('foreign', item->'usd', 'thb', item->'thb'),
        'totalAmount', jsonb_build_object('foreign', 99999, 'thb', 99999),
        'feeIncludeVat', jsonb_build_object('foreign', 999, 'thb', 999)),
      coalesce((item->>'duplicate')::boolean, false));
    idx := idx + 1;
  end loop;
  result := public.get_stock_holdings(uid, true);
  select value into position from jsonb_array_elements(result->'items') where value->>'accountNumber' = account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'USD';
  -- 016 changes only the RPC's offshore branch; the pure moving-average helper
  -- cases above remain unchanged and still protect Thai-stock calculations.
  if basis is null or basis->>'status' <> 'CALCULATED' or (basis->>'remainingCost')::numeric is distinct from
    (case when position->>'costBasisMethod' = 'COMPRESSED_FIFO' then 190::numeric else 180::numeric end)
    then raise exception 'RPC average cost incorrect or duplicates included: %', position; end if;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if basis is null or (basis->>'remainingCost')::numeric is distinct from
    (case when position->>'costBasisMethod' = 'COMPRESSED_FIFO' then 6790::numeric else 6405::numeric end)
    then raise exception 'RPC THB cost incorrect'; end if;
  if result->'remainingCostTotals' is distinct from public.get_stock_holdings(uid, false)->'remainingCostTotals'
    then raise exception 'Display filter changed cost totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'remainingCostTotals' <> '[]'::jsonb
    then raise exception 'Cost leaked across users'; end if;
  raise notice 'Average cost checks passed; rolling back fixtures';
end;
$$;
rollback;
