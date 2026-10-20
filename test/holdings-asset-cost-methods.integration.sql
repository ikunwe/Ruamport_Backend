-- Development PostgreSQL/Supabase, after 017. All fixtures roll back.
begin;
do $$
declare
  orders jsonb := '[
    {"tradeDate":"2000-01-01","movement":"BUY","units":10,"grossAmount":100},
    {"tradeDate":"2000-01-02","movement":"BUY","units":20,"grossAmount":400},
    {"tradeDate":"2000-01-03","movement":"SELL","units":5,"grossAmount":99999}
  ]';
  result jsonb;
  bad jsonb;
begin
  result := public.investment_fifo_cost(orders, 'THB', 25, 25, 0.0000003);
  if not (result @> '{"status":"CALCULATED","remainingCost":450,"averageCostPerUnit":18}'::jsonb)
    then raise exception 'Not per-order FIFO: %', result; end if;
  select jsonb_agg(value order by ord desc) into bad from jsonb_array_elements(orders) with ordinality e(value, ord);
  if public.investment_fifo_cost(bad, 'THB', 25, 25, 0.0000003) is distinct from result
    then raise exception 'FIFO depends on import order'; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":10}]'::jsonb, 'THB', 15, 15, 0.0000003);
  if not (result @> '{"remainingCost":300,"averageCostPerUnit":20}'::jsonb)
    then raise exception 'FIFO did not cross purchase lots correctly: %', result; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":25}]'::jsonb, 'THB', 0, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"averageCostPerUnit":null}'::jsonb) then raise exception 'Full sale failed'; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":25},{"tradeDate":"2000-01-05","movement":"BUY","units":2,"grossAmount":100}]'::jsonb, 'THB', 2, 2, 0.0000003);
  if not (result @> '{"remainingCost":100,"averageCostPerUnit":50}'::jsonb) then raise exception 'Reopened FIFO failed'; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":25.0000002}]'::jsonb, 'THB', -0.0000002, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"rawRemainingCost":-0.000004,"roundingAdjusted":true}'::jsonb)
    then raise exception 'FIFO raw negative dust lost: %', result; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","units":24.9999998}]'::jsonb, 'THB', 0.0000002, 0, 0.0000003);
  if not (result @> '{"remainingCost":0,"rawRemainingCost":0.000004,"roundingAdjusted":true}'::jsonb)
    then raise exception 'FIFO raw positive dust lost'; end if;
  for bad in select value from jsonb_array_elements('[
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1}],"issue":"BUY_GROSS_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":"bad"}],"issue":"BUY_GROSS_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":0,"grossAmount":10}],"issue":"INVALID_COST_UNITS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":-10}],"issue":"INVALID_BUY_GROSS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SELL","units":1}],"issue":"SELL_EXCEEDS_AVAILABLE_UNITS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"REWARD","units":1}],"issue":"UNSUPPORTED_COST_TRANSACTION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":1,"grossAmount":10,"collision":true}],"issue":"ORDER_ID_COLLISION"},
    {"orders":[{"movement":"BUY","units":1,"grossAmount":10}],"issue":"TRADE_DATE_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","units":2,"grossAmount":10},{"tradeDate":"2000-01-01","movement":"SELL","units":1}],"issue":"INTRADAY_ORDER_AMBIGUOUS"}
  ]'::jsonb) loop
    result := public.investment_fifo_cost(bad->'orders', 'THB', 1, 1, null);
    if result->>'status' <> 'INCOMPLETE' or not ((result->'issues') ? (bad->>'issue'))
      then raise exception 'Unsafe FIFO input accepted: %, %', bad, result; end if;
  end loop;
  -- Same-day different-price buys can be retained entirely, but not partially
  -- consumed by an unknown order. Equal-price lots remain computable.
  orders := '[{"tradeDate":"2000-01-01","movement":"BUY","units":10,"grossAmount":100},{"tradeDate":"2000-01-01","movement":"BUY","units":20,"grossAmount":400}]';
  result := public.investment_fifo_cost(orders, 'THB', 30, 30, null);
  if not (result @> '{"status":"CALCULATED","remainingCost":500}'::jsonb) then raise exception 'Untouched same-day lots unnecessarily blocked'; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-02","movement":"SELL","units":5}]'::jsonb, 'THB', 25, 25, null);
  if not (result @> '{"status":"INCOMPLETE","remainingCost":null,"issues":["INTRADAY_BUY_ORDER_AMBIGUOUS"]}'::jsonb)
    then raise exception 'Unknown intraday buy sequence was invented'; end if;
  result := public.investment_fifo_cost(orders || '[{"tradeDate":"2000-01-02","movement":"SELL","units":30}]'::jsonb, 'THB', 0, 0, null);
  if not (result @> '{"status":"CALCULATED","remainingCost":0}'::jsonb) then raise exception 'Fully consumed same-day lots blocked'; end if;
  result := public.investment_fifo_cost('[{"tradeDate":"2000-01-01","movement":"BUY","units":10,"grossAmount":100},{"tradeDate":"2000-01-01","movement":"BUY","units":20,"grossAmount":200},{"tradeDate":"2000-01-02","movement":"SELL","units":5}]', 'THB', 25, 25, null);
  if not (result @> '{"status":"CALCULATED","remainingCost":250,"averageCostPerUnit":10}'::jsonb) then raise exception 'Equal-price ordering not recognized'; end if;
end;
$$;

do $$
declare
  uid uuid;
  account text := 'asset-cost-test-' || gen_random_uuid()::text;
  asset text;
  doc uuid;
  item jsonb;
  result jsonb;
  position jsonb;
  basis jsonb;
  idx integer;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  foreach asset in array array['OFFSHORE', 'THAI', 'FUND'] loop
    insert into public.investment_documents(user_id, content_hash, status, preview)
      values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
        jsonb_build_object('document', jsonb_build_object('type', case asset when 'THAI' then 'DIME_THAI_STOCK_CONFIRMATION_NOTE'
          when 'FUND' then 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE' else 'DIME_OFFSHORE_CONFIRMATION_NOTE' end, 'accountNumber', account))) returning id into doc;
    idx := 0;
    for item in select value from jsonb_array_elements('[
      {"type":"BUY","date":"2000-01-01","units":10,"gross":100},
      {"type":"BUY","date":"2000-01-02","units":20,"gross":400},
      {"type":"SELL","date":"2000-01-03","units":5,"gross":99999},
      {"type":"BUY","date":"2000-01-01","units":10,"gross":100,"duplicate":true}
    ]'::jsonb) loop
      insert into public.investment_transactions(user_id, document_id, order_index, order_id,
        transaction_type, asset_name, currency, units, trade_date, details, is_duplicate)
      values(uid, doc, idx, asset||idx, case when asset = 'FUND' then case item->>'type' when 'BUY' then 'SUBSCRIPTION' else 'REDEMPTION' end else item->>'type' end,
        asset||account, case when asset = 'OFFSHORE' then 'USD' else 'THB' end,
        (item->>'units')::numeric, (item->>'date')::date,
        jsonb_build_object('grossAmount', case when asset = 'OFFSHORE' then jsonb_build_object('foreign', item->'gross', 'thb', (item->>'gross')::numeric * 35) else item->'gross' end,
          'totalAmount', case when asset = 'FUND' then item->'gross' else '99999'::jsonb end,
          'feeIncludeVat', 999), coalesce((item->>'duplicate')::boolean, false));
      idx := idx + 1;
    end loop;
  end loop;
  result := public.get_stock_holdings(uid, true);
  if not (result->'costBasisMethods' @> '{"OFFSHORE_STOCK":"COMPRESSED_FIFO","THAI_STOCK":"FIFO","MUTUAL_FUND":"MOVING_WEIGHTED_AVERAGE"}'::jsonb)
    then raise exception 'Wrong method mapping'; end if;
  foreach asset in array array['OFFSHORE', 'THAI', 'FUND'] loop
    select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = asset||account;
    select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = case when asset = 'OFFSHORE' then 'USD' else 'THB' end;
    if basis is null or basis->>'status' <> 'CALCULATED' then raise exception 'Missing asset cost: %', position; end if;
    if asset = 'FUND' then
      if basis->>'method' <> 'MOVING_WEIGHTED_AVERAGE' or abs((basis->>'remainingCost')::numeric - 500::numeric/30*25) > 0.000000000001
        then raise exception 'Fund Average Cost was changed to FIFO: %', basis; end if;
    elsif (basis->>'remainingCost')::numeric <> 450 or (basis->>'averageCostPerUnit')::numeric <> 18
      then raise exception 'Stock FIFO cost incorrect: %', basis;
    end if;
    if asset = 'THAI' and (basis->>'method' <> 'FIFO' or position->>'costBasisOrder' <> 'TRADE_DATE_INDIVIDUAL_LOTS')
      then raise exception 'Thai FIFO metadata missing'; end if;
    if asset <> 'OFFSHORE' and jsonb_array_length(position->'costBasis') <> 1 then raise exception 'Fabricated USD for THB asset'; end if;
  end loop;
  if result->'remainingCostTotals' is distinct from public.get_stock_holdings(uid, false)->'remainingCostTotals'
    then raise exception 'Display filter changed cost totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'remainingCostTotals' <> '[]'::jsonb then raise exception 'Tenant isolation failed'; end if;
  raise notice 'Asset-specific cost checks passed; rolling back fixtures';
end;
$$;
rollback;
