-- Development PostgreSQL/Supabase, after 018. Every fixture is rolled back.
begin;
do $$
declare
  orders jsonb := '[
    {"tradeDate":"2000-01-01","movement":"BUY","assetType":"MUTUAL_FUND","currency":"THB","units":10,"totalAmount":100,"feeIncludeVat":3,"grossAmount":99999},
    {"tradeDate":"2000-01-02","movement":"BUY","assetType":"MUTUAL_FUND","currency":"THB","units":10,"totalAmount":140,"feeIncludeVat":9},
    {"tradeDate":"2000-01-03","movement":"SELL","assetType":"MUTUAL_FUND","currency":"THB","units":5,"totalAmount":99999,"feeIncludeVat":50}
  ]';
  result jsonb;
  bad jsonb;
  reversed jsonb;
begin
  result := public.investment_mutual_fund_average_cost(orders, 15, 15);
  if not (result @> '{"status":"CALCULATED","averageCostPerUnit":12,"remainingCost":180,"source":"PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES","feesIncluded":false}'::jsonb)
    then raise exception 'Fund amount mapping/fee exclusion failed: %', result; end if;
  select jsonb_agg(value order by ord desc) into reversed from jsonb_array_elements(orders) with ordinality e(value, ord);
  if public.investment_mutual_fund_average_cost(reversed, 15, 15) is distinct from result
    then raise exception 'Fund average depends on upload order'; end if;
  result := public.investment_mutual_fund_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"BUY","currency":"THB","units":5,"totalAmount":100,"feeIncludeVat":999}]'::jsonb, 20, 20);
  if not (result @> '{"averageCostPerUnit":14,"remainingCost":280}'::jsonb)
    then raise exception 'Buy after partial redemption failed'; end if;
  result := public.investment_mutual_fund_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","currency":"THB","units":15}]'::jsonb, 0, 0);
  if not (result @> '{"averageCostPerUnit":null,"remainingCost":0}'::jsonb) then raise exception 'Full fund redemption failed'; end if;
  result := public.investment_mutual_fund_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","currency":"THB","units":15},{"tradeDate":"2000-01-05","movement":"BUY","currency":"THB","units":2,"totalAmount":50}]'::jsonb, 2, 2);
  if not (result @> '{"averageCostPerUnit":25,"remainingCost":50}'::jsonb) then raise exception 'Reopened fund average failed'; end if;
  result := public.investment_mutual_fund_average_cost(orders || '[{"tradeDate":"2000-01-04","movement":"SELL","currency":"THB","units":14.9999998}]'::jsonb, 0.0000002, 0.0000002);
  if not (result @> '{"remainingCost":0.0000024,"averageCostPerUnit":12,"roundingAdjusted":false}'::jsonb)
    then raise exception 'Stock dust tolerance incorrectly applied to fund: %', result; end if;
  -- Multiple subscriptions on one day may be averaged; no intraday sales here.
  result := public.investment_mutual_fund_average_cost('[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":10,"totalAmount":100},{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":10,"totalAmount":140},{"tradeDate":"2000-01-02","movement":"SELL","currency":"THB","units":5}]', 15, 15);
  if not (result @> '{"remainingCost":180,"averageCostPerUnit":12}'::jsonb) then raise exception 'Same-day subscriptions failed'; end if;
  for bad in select value from jsonb_array_elements('[
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":1,"grossAmount":10}],"issue":"BUY_AMOUNT_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":1,"totalAmount":"bad"}],"issue":"BUY_AMOUNT_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":1,"totalAmount":-10}],"issue":"INVALID_BUY_AMOUNT"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"USD","units":1,"totalAmount":10}],"issue":"COST_CURRENCY_UNSUPPORTED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SELL","currency":"THB","units":1}],"issue":"SELL_EXCEEDS_AVAILABLE_UNITS"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SWITCH_IN","currency":"THB","units":1,"totalAmount":10}],"issue":"UNSUPPORTED_COST_TRANSACTION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"SWITCH_OUT","currency":"THB","units":1,"totalAmount":10}],"issue":"UNSUPPORTED_COST_TRANSACTION"},
    {"orders":[{"movement":"BUY","currency":"THB","units":1,"totalAmount":10}],"issue":"TRADE_DATE_REQUIRED"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":1,"totalAmount":10,"collision":true}],"issue":"ORDER_ID_COLLISION"},
    {"orders":[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","units":2,"totalAmount":20},{"tradeDate":"2000-01-01","movement":"SELL","currency":"THB","units":1}],"issue":"INTRADAY_ORDER_AMBIGUOUS"}
  ]'::jsonb) loop
    result := public.investment_mutual_fund_average_cost(bad->'orders', 1, 1);
    if result->>'status' <> 'INCOMPLETE' or result->>'remainingCost' is not null or not ((result->'issues') ? (bad->>'issue'))
      then raise exception 'Unsafe fund cost input accepted: %, %', bad, result; end if;
  end loop;
end;
$$;

do $$
declare
  uid uuid;
  account text := 'fund-average-test-' || gen_random_uuid()::text;
  preview_json jsonb;
  base_order jsonb;
  orders jsonb;
  registered jsonb;
  imported jsonb;
  doc uuid;
  result jsonb;
  position jsonb;
  basis jsonb;
  original_details jsonb;
  after_details jsonb;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  base_order := jsonb_build_object('fundName', account, 'currency', 'THB', 'feeIncludeVat', 999);
  orders := jsonb_build_array(
    base_order || jsonb_build_object('orderId', 'SUB1', 'transactionType', 'SUBSCRIPTION', 'tradeDate', '2000-01-01', 'units', 10, 'navPerUnit', 10, 'totalAmount', 100),
    base_order || jsonb_build_object('orderId', 'SUB2', 'transactionType', 'SUBSCRIPTION', 'tradeDate', '2000-01-02', 'units', 10, 'navPerUnit', 14, 'totalAmount', 140),
    base_order || jsonb_build_object('orderId', 'RED1', 'transactionType', 'REDEMPTION', 'tradeDate', '2000-01-03', 'units', 5, 'navPerUnit', 50, 'totalAmount', 250)
  );
  preview_json := jsonb_build_object('document', jsonb_build_object('type', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE', 'accountNumber', account, 'documentNumber', 'fund-test-1'),
    'orders', orders, 'validation', jsonb_build_object('isValid', false, 'warnings', jsonb_build_array(jsonb_build_object('code', 'MUTUAL_FUND_FEE_TOTAL_MISMATCH'))));
  registered := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':1', preview_json);
  doc := (registered->'document'->>'id')::uuid;
  imported := public.import_investment_document(uid, doc);
  if (imported->>'transactionCount')::int <> 3 then raise exception 'Legacy fund import failed'; end if;
  select jsonb_agg(details order by order_index) into original_details from public.investment_transactions where document_id = doc;
  result := public.get_stock_holdings(uid, true);
  select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if basis is null or not (basis @> '{"method":"MOVING_WEIGHTED_AVERAGE","status":"CALCULATED","averageCostPerUnit":12,"remainingCost":180,"source":"PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES","feesIncluded":false}'::jsonb)
    then raise exception 'Existing rows without gross did not compute correctly: %', position; end if;
  if (position->>'quantity')::numeric <> 15 or jsonb_array_length(position->'costBasis') <> 1 then raise exception 'Fund quantity/currency changed'; end if;
  if position->>'costBasisSource' <> 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES' then raise exception 'Fund source metadata missing'; end if;
  select jsonb_agg(details order by order_index) into after_details from public.investment_transactions where document_id = doc;
  if after_details is distinct from original_details then raise exception 'Cost normalization mutated stored details'; end if;
  -- Same original order JSON in another PDF must still deduplicate, with no
  -- derived gross/source fields added to the persisted order signatures.
  registered := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':2', preview_json);
  imported := public.import_investment_document(uid, (registered->'document'->>'id')::uuid);
  if (imported->>'transactionCount')::int <> 0 or (imported->>'duplicateOrderCount')::int <> 3 then raise exception 'Fund normalization broke dedup'; end if;
  select value into position from jsonb_array_elements(public.get_stock_holdings(uid, true)->'items') where value->>'symbol' = account;
  select value into basis from jsonb_array_elements(position->'costBasis') where value->>'currency' = 'THB';
  if (basis->>'remainingCost')::numeric <> 180 then raise exception 'Repeated document changed cost'; end if;
  if public.get_stock_holdings(uid, false)->'remainingCostTotals' is distinct from result->'remainingCostTotals' then raise exception 'Closed filter or repeated import changed totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'remainingCostTotals' <> '[]'::jsonb then raise exception 'Fund cost leaked across users'; end if;
  raise notice 'Fund Average Cost checks passed; rolling back fixtures';
end;
$$;
rollback;
