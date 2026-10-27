-- Isolated development PostgreSQL only; no production credentials. All fixtures rolled back.
begin;
do $$
declare
  orders jsonb := '[{"tradeDate":"2000-01-01","movement":"BUY","assetType":"OFFSHORE_STOCK","currency":"USD","units":10,"grossAmount":{"foreign":100,"thb":3500}}, {"tradeDate":"2000-01-02","movement":"BUY","assetType":"OFFSHORE_STOCK","currency":"USD","units":10,"grossAmount":{"foreign":200,"thb":7200}}, {"tradeDate":"2000-01-03","movement":"SELL","assetType":"OFFSHORE_STOCK","currency":"USD","units":5,"grossAmount":{"foreign":80,"thb":2880}}]';
  c jsonb;
  r jsonb;
  t jsonb;
begin
  c := public.investment_compressed_fifo_cost(orders, 'USD', 15, 15, null);
  r := public.investment_realized_pnl(orders, c || '{"method":"COMPRESSED_FIFO"}', 'OFFSHORE_STOCK');
  if not (r @> '{"status":"CALCULATED","soldCost":50,"realizedPnl":30,"totalBuyValue":300,"totalSellValue":80,"feesIncluded":false}') then raise exception 'USD realized wrong: %', r; end if;
  c := public.investment_compressed_fifo_cost(orders, 'THB', 15, 15, null);
  r := public.investment_realized_pnl(orders, c, 'OFFSHORE_STOCK');
  if not (r @> '{"status":"CALCULATED","soldCost":1750,"realizedPnl":1130}') then raise exception 'Historical THB wrong: %', r; end if;
  -- Missing sale value must not affect original cost, but cannot produce profit.
  t := jsonb_set(orders, '{2,grossAmount,foreign}', 'null');
  c := public.investment_compressed_fifo_cost(t, 'USD', 15, 15, null);
  if c->>'status' <> 'CALCULATED' then raise exception 'Fixture cost unexpected'; end if;
  r := public.investment_realized_pnl(t, c, 'OFFSHORE_STOCK');
  if r->>'status' <> 'INCOMPLETE' or r->>'realizedPnl' is not null or not ((r->'issues') ? 'SELL_VALUE_REQUIRED') then raise exception 'Missing sale value accepted: %', r; end if;
  t := jsonb_set(orders, '{2,grossAmount,foreign}', '-1');
  r := public.investment_realized_pnl(t, c, 'OFFSHORE_STOCK');
  if r->>'realizedPnl' is not null then raise exception 'Negative sale value accepted'; end if;
  -- Costs remain asset-specific; fund totalAmount is already separate from fees.
  t := '[{"tradeDate":"2000-01-01","movement":"BUY","currency":"THB","assetType":"MUTUAL_FUND","units":10,"totalAmount":100,"feeIncludeVat":999}, {"tradeDate":"2000-01-02","movement":"BUY","currency":"THB","assetType":"MUTUAL_FUND","units":10,"totalAmount":200}, {"tradeDate":"2000-01-03","movement":"SELL","currency":"THB","assetType":"MUTUAL_FUND","units":5,"totalAmount":80}]';
  c := public.investment_mutual_fund_average_cost(t, 15, 15);
  r := public.investment_realized_pnl(t, c, 'MUTUAL_FUND');
  if not (r @> '{"soldCost":75,"realizedPnl":5}') then raise exception 'Fund average cost wrong: %', r; end if;
  t := '[{"tradeDate":"2000-01-01","movement":"BUY","assetType":"THAI_STOCK","currency":"THB","units":10,"grossAmount":100}, {"tradeDate":"2000-01-02","movement":"SELL","assetType":"THAI_STOCK","currency":"THB","units":10,"grossAmount":80}]';
  c := public.investment_fifo_cost(t, 'THB', 0, 0, null);
  r := public.investment_realized_pnl(t, c, 'THAI_STOCK');
  if not (r @> '{"soldCost":100,"realizedPnl":-20}') then raise exception 'Closed loss wrong: %', r; end if;
  t := '[{"tradeDate":"2000-01-01","movement":"BUY","assetType":"THAI_STOCK","currency":"THB","units":10,"grossAmount":100}]';
  c := public.investment_fifo_cost(t, 'THB', 10, 10, null);
  r := public.investment_realized_pnl(t, c, 'THAI_STOCK');
  if not (r @> '{"soldCost":0,"realizedPnl":0}') then raise exception 'Never sold wrong: %', r; end if;
  r := public.investment_realized_pnl(t, '{"currency":"THB","status":"INCOMPLETE","remainingCost":null,"issues":["ORDER_ID_COLLISION"]}', 'THAI_STOCK');
  if r->>'soldCost' is not null or r->>'realizedPnl' is not null then raise exception 'Incomplete cost accepted'; end if;
  r := public.investment_realized_pnl_totals(jsonb_build_array(r, '{"currency":"THB","status":"CALCULATED","soldCost":100,"realizedPnl":20}'));
  if r->0->>'isComplete' <> 'false' or r->0->>'realizedPnl' is not null then raise exception 'Partial totals disguised as complete: %', r; end if;
  if public.investment_realized_pnl_totals('[]') <> '[]' then raise exception 'Empty portfolio wrong'; end if;
end;
$$;
do $$
declare
  uid uuid; doc uuid; result jsonb; filtered jsonb; position jsonb; row jsonb;
  symbol text := 'PNL-' || gen_random_uuid()::text;
begin
  select id into uid from auth.users limit 1;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', symbol))) returning id into doc;
  insert into public.investment_transactions(user_id, document_id, order_index, order_id,
    transaction_type, asset_name, currency, units, trade_date, details)
  values
    (uid, doc, 0, 'BUY', 'BUY', symbol, 'USD', 10, '2000-01-01', '{"grossAmount":{"foreign":100,"thb":3500},"totalAmount":{"foreign":9999,"thb":99999},"feeIncludeVat":{"foreign":999,"thb":999}}'),
    (uid, doc, 1, 'SELL', 'SELL', symbol, 'USD', 10, '2000-01-02', '{"grossAmount":{"foreign":120,"thb":4320}}'),
    (uid, doc, 2, 'DUP', 'BUY', symbol, 'USD', 999, '2000-01-01', '{"grossAmount":{"foreign":99999,"thb":99999}}');
  update public.investment_transactions set is_duplicate = true where document_id = doc and order_index = 2;
  result := public.get_stock_holdings(uid, true);
  filtered := public.get_stock_holdings(uid, false);
  select value into position from jsonb_array_elements(result->'items') where value->>'symbol' = symbol;
  if position is null or position->>'status' <> 'CLOSED' then raise exception 'Closed fixture absent'; end if;
  select value into row from jsonb_array_elements(position->'realizedPnl') where value->>'currency' = 'USD';
  if row is null or not (row @> '{"soldCost":100,"realizedPnl":20,"method":"COMPRESSED_FIFO","status":"CALCULATED"}') then raise exception 'Holdings USD contract wrong: %', position; end if;
  select value into row from jsonb_array_elements(position->'realizedPnl') where value->>'currency' = 'THB';
  if row is null or not (row @> '{"soldCost":3500,"realizedPnl":820}') then raise exception 'Holdings THB contract wrong: %', position; end if;
  if exists(select 1 from jsonb_array_elements(filtered->'items') x where x->>'symbol' = symbol) then raise exception 'Closed filter broken'; end if;
  if result->'realizedPnlTotals' is distinct from filtered->'realizedPnlTotals' then raise exception 'Filter changed realized totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'realizedPnlTotals' <> '[]' then raise exception 'Realized PnL leaked across users'; end if;
end;
$$;
rollback;
