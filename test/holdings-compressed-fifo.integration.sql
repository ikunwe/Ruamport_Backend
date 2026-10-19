-- Development PostgreSQL/Supabase, after 016. All fixtures roll back.
begin;
do $$
declare
  orders jsonb := '[
    {"tradeDate":"2000-01-01","movement":"BUY","units":10,"grossAmount":{"foreign":100,"thb":3500}},
    {"tradeDate":"2000-01-01","movement":"BUY","units":20,"grossAmount":{"foreign":400,"thb":14000}},
    {"tradeDate":"2000-01-02","movement":"BUY","units":10,"grossAmount":{"foreign":300,"thb":10800}},
    {"tradeDate":"2000-01-03","movement":"SELL","units":6,"grossAmount":{"foreign":99999,"thb":99999}}
  ]';
  result jsonb;
  reversed jsonb;
  bad jsonb;
begin
  -- Compressed FIFO: first daily lot is 30 units / USD 500, not two FIFO lots.
  -- Sell 6 => USD 100 removed, USD 700 left (ordinary FIFO=740, average=680).
  result := public.investment_compressed_fifo_cost(orders, 'USD', 34, 34, 0.0000003);
  if not (result @> '{"status":"CALCULATED","remainingCost":700,"rawRemainingCost":700}'::jsonb)
    or abs((result->>'averageCostPerUnit')::numeric - 700::numeric/34) > 0.000000000001
    then raise exception 'Not compressed weighted daily FIFO: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders, 'THB', 34, 34, 0.0000003);
  if not (result @> '{"status":"CALCULATED","remainingCost":24800}'::jsonb)
    then raise exception 'Historical THB cost not independently consumed: %', result; end if;
  select jsonb_agg(value order by ord desc) into reversed from jsonb_array_elements(orders) with ordinality e(value, ord);
  if public.investment_compressed_fifo_cost(reversed, 'USD', 34, 34, 0.0000003)
    is distinct from public.investment_compressed_fifo_cost(orders, 'USD', 34, 34, 0.0000003)
    then raise exception 'Calculation depends on PDF/import order'; end if;
  orders := orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":27}]'::jsonb;
  result := public.investment_compressed_fifo_cost(orders, 'USD', 7, 7, 0.0000003);
  if not (result @> '{"remainingCost":210,"averageCostPerUnit":30}'::jsonb)
    then raise exception 'Sale spanning daily lots incorrect: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders, 'THB', 7, 7, 0.0000003);
  if not (result @> '{"remainingCost":7560,"averageCostPerUnit":1080}'::jsonb)
    then raise exception 'THB sale spanning lots incorrect'; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":7}]'::jsonb, 'USD', 0, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"averageCostPerUnit":null,"status":"CALCULATED"}'::jsonb)
    then raise exception 'Exact full sale failed: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":7},{"tradeDate":"2000-01-06","movement":"BUY","units":2,"grossAmount":{"foreign":100}}]'::jsonb, 'USD', 2, 2, 0.0000003);
  if not (result @> '{"remainingCost":100,"averageCostPerUnit":50}'::jsonb)
    then raise exception 'Closed/reopened daily queue not reset: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":7.0000002}]'::jsonb, 'USD', -0.0000002, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"rawRemainingCost":-0.000006,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Tiny negative residue not preserved: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":6.9999998}]'::jsonb, 'USD', 0.0000002, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"rawRemainingCost":0.000006,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Tiny positive residue not preserved: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":7.0000002},{"tradeDate":"2000-01-06","movement":"BUY","units":2,"grossAmount":{"foreign":100}}]'::jsonb, 'USD', 1.9999998, 1.9999998, 0.0000003);
  if not (result @> '{"remainingCost":99.99999,"rawRemainingCost":100,"averageCostPerUnit":50,"roundingAdjusted":true}'::jsonb)
    then raise exception 'Tiny oversale reopening failed: %', result; end if;
  result := public.investment_compressed_fifo_cost(orders || '[{"tradeDate":"2000-01-05","movement":"SELL","units":7.0000005}]'::jsonb, 'USD', -0.0000005, -0.0000005, 0.0000003);
  if not (result @> '{"status":"INCOMPLETE","remainingCost":null,"issues":["SELL_EXCEEDS_AVAILABLE_UNITS"]}'::jsonb)
    then raise exception 'Large oversale not rejected'; end if;
  for bad in select value from jsonb_array_elements('[
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1}],"issue":"BUY_GROSS_REQUIRED"},
    {"orders":[{"movement":"BUY","units":1,"grossAmount":{"foreign":10}}],"issue":"TRADE_DATE_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":0,"grossAmount":{"foreign":10}}],"issue":"INVALID_COST_UNITS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":{"foreign":-10}}],"issue":"INVALID_BUY_GROSS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"REWARD","units":1}],"issue":"UNSUPPORTED_COST_TRANSACTION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":{"foreign":10},"collision":true}],"issue":"ORDER_ID_COLLISION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":2,"grossAmount":{"foreign":10}},{"tradeDate":"2000-01-01","movement":"SELL","units":1}],"issue":"INTRADAY_ORDER_AMBIGUOUS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SELL","units":1},{"tradeDate":"2000-01-02","movement":"BUY","units":2,"grossAmount":{"foreign":10}}],"issue":"SELL_EXCEEDS_AVAILABLE_UNITS"}
  ]'::jsonb) loop
    result := public.investment_compressed_fifo_cost(bad->'orders', 'USD', 1, 1, null);
    if result->>'status' <> 'INCOMPLETE' or result->>'remainingCost' is not null
      or not ((result->'issues') ? (bad->>'issue')) then raise exception 'Unsafe case accepted: %, %', bad, result; end if;
  end loop;
  result := public.investment_compressed_fifo_cost('[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":{"foreign":10}}]', 'THB', 1, 1, null);
  if not (result @> '{"status":"INCOMPLETE","issues":["BUY_GROSS_REQUIRED"]}'::jsonb)
    then raise exception 'THB filled from foreign gross'; end if;
  result := public.investment_compressed_fifo_cost(orders, 'USD', 6, 6, 0.0000003);
  if not ((result->'issues') ? 'COST_QUANTITY_MISMATCH') then raise exception 'Quantity mismatch not rejected'; end if;
end;
$$;

do $$
declare
  uid uuid;
  account text := 'compressed-test-' || gen_random_uuid()::text;
  offshore uuid;
  thai uuid;
  fund uuid;
  pending uuid;
  item jsonb;
  asset text;
  doc uuid;
  result jsonb;
  position jsonb;
  basis jsonb;
  idx integer;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  foreach asset in array array['OFFSHORE', 'THAI', 'FUND', 'PENDING'] loop
    insert into public.investment_documents(user_id, content_hash, status, preview)
      values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), case when asset = 'PENDING' then 'PREVIEW' else 'IMPORTED' end,
        jsonb_build_object('document', jsonb_build_object('type', case asset when 'THAI' then 'DIME_THAI_STOCK_CONFIRMATION_NOTE'
          when 'FUND' then 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE' else 'DIME_OFFSHORE_CONFIRMATION_NOTE' end, 'accountNumber', account))) returning id into doc;
    case asset when 'OFFSHORE' then offshore := doc; when 'THAI' then thai := doc;
      when 'FUND' then fund := doc; else pending := doc; end case;
  end loop;
  foreach asset in array array['OFFSHORE', 'THAI'] loop
    idx := 0;
    for item in select value from jsonb_array_elements('[
      {"type":"SELL","date":"2000-01-03","units":6,"usd":9999,"thb":9999},
      {"type":"BUY","date":"2000-01-02","units":10,"usd":300,"thb":10800},
      {"type":"BUY","date":"2000-01-01","units":10,"usd":100,"thb":3500},
      {"type":"BUY","date":"2000-01-01","units":20,"usd":400,"thb":14000},
      {"type":"BUY","date":"2000-01-01","units":20,"usd":400,"thb":14000,"duplicate":true},
      {"type":"BUY","date":"2000-01-04","units":999,"usd":99999,"thb":99999,"pending":true}
    ]'::jsonb) loop
      insert into public.investment_transactions(user_id, document_id, order_index, order_id,
        transaction_type, asset_name, currency, units, trade_date, details, is_duplicate)
      values(uid, case when item->>'pending' = 'true' then pending when asset = 'OFFSHORE' then offshore else thai end,
        idx + case when asset = 'THAI' then 100 else 0 end, asset||idx, item->>'type', asset||account,
        case when asset = 'OFFSHORE' then 'USD' else 'THB' end, (item->>'units')::numeric, (item->>'date')::date,
        jsonb_build_object('grossAmount', case when asset = 'OFFSHORE' then jsonb_build_object('foreign', item->'usd', 'thb', item->'thb') else item->'usd' end,
          'totalAmount', 99999, 'feeIncludeVat', 999), coalesce((item->>'duplicate')::boolean, false));
      idx := idx + 1;
    end loop;
  end loop;
  insert into public.investment_transactions(user_id, document_id, order_index, order_id, transaction_type,
    asset_name, currency, units, trade_date, details) values(uid, fund, 0, 'SUB', 'SUBSCRIPTION', 'FUND'||account, 'THB', 1, '2000-01-01', '{"totalAmount":100,"feeIncludeVat":1}');
  result := public.get_stock_holdings(uid, true);
  if result->>'costBasisMethod' <> 'BY_ASSET_TYPE' or result->'costBasisMethods'->>'OFFSHORE_STOCK' <> 'COMPRESSED_FIFO'
    then raise exception 'Mixed-method metadata missing'; end if;
  select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = 'OFFSHORE'||account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'USD';
  if basis is null or not (basis @> '{"remainingCost":700,"method":"COMPRESSED_FIFO","status":"CALCULATED"}'::jsonb)
    or position->>'costBasisMethod' <> 'COMPRESSED_FIFO' then raise exception 'Offshore branch not switched: %', position; end if;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if basis is null or (basis->>'remainingCost')::numeric <> 24800 then raise exception 'Independent THB cost failed'; end if;
  select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = 'THAI'||account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if result->'costBasisMethods'->>'THAI_STOCK' = 'FIFO' then
    -- 017 changes Thai to FIFO. This fixture has two different-price buys on
    -- one date and an unknown execution order at the remaining-lot boundary.
    if basis is null or not (basis @> '{"status":"INCOMPLETE","method":"FIFO","issues":["INTRADAY_BUY_ORDER_AMBIGUOUS"]}'::jsonb)
      then raise exception 'Ambiguous Thai FIFO order silently assumed: %', position; end if;
  elsif basis is null or not (basis @> '{"remainingCost":680,"averageCostPerUnit":20,"method":"MOVING_WEIGHTED_AVERAGE"}'::jsonb) then
    raise exception 'Thai method unexpectedly changed before 017: %', position;
  end if;
  if jsonb_array_length(position->'costBasis') <> 1 then raise exception 'Fabricated Thai USD'; end if;
  select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = 'FUND'||account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if result->'costBasisSources'->>'MUTUAL_FUND' = 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES' then
    -- 018 deliberately uses the stored fund Total Amount (100 THB), not fees.
    if basis is null or not (basis @> '{"status":"CALCULATED","method":"MOVING_WEIGHTED_AVERAGE","remainingCost":100,"averageCostPerUnit":100}'::jsonb)
      then raise exception 'Fund Total Amount cost mapping failed'; end if;
  elsif basis is null or not (basis @> '{"status":"INCOMPLETE","method":"MOVING_WEIGHTED_AVERAGE"}'::jsonb) then
    raise exception 'Fund unknown gross silently estimated before 018';
  end if;
  if result->'remainingCostTotals' is distinct from public.get_stock_holdings(uid, false)->'remainingCostTotals'
    then raise exception 'Display filter changed totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'remainingCostTotals' <> '[]'::jsonb then raise exception 'Tenant isolation failed'; end if;
  raise notice 'Compressed FIFO checks passed; rolling back fixtures';
end;
$$;
rollback;
