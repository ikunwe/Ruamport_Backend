-- Read-only sell simulation; run after 021. No changes to stored trades or holdings RPC.
begin;
create or replace function public.simulate_investment_sale(p_user_id uuid, p_request jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  rows jsonb; orders jsonb; snapshot jsonb; position jsonb; before_cost jsonb; after_cost jsonb;
  revision text; last_date text; method text; ccy text := p_request->>'currency';
  asset text := p_request->>'assetType'; sim_date text := p_request->>'tradeDate';
  qty numeric; price numeric; proceeds numeric; raw_after numeric; display_after numeric;
  cost_sold numeric; pnl numeric; pct numeric; tolerance numeric; excluded integer; collision boolean;
  issues jsonb := '[]'::jsonb; complete boolean; source text;
begin
  if p_request->>'action' is distinct from 'SELL'
    or coalesce(asset not in ('OFFSHORE_STOCK', 'THAI_STOCK', 'MUTUAL_FUND'), true)
    or jsonb_typeof(p_request->'quantity') is distinct from 'number'
    or jsonb_typeof(p_request->'price') is distinct from 'number' then
    return jsonb_build_object('errorCode', 'INVALID_SIMULATION_REQUEST');
  end if;
  qty := (p_request->>'quantity')::numeric; price := (p_request->>'price')::numeric;
  if qty <= 0 or price <= 0 or qty > 1000000000 or price > 1000000000 or qty * price > 1000000000000
    or ccy is distinct from (case when asset = 'OFFSHORE_STOCK' then 'USD' else 'THB' end) then
    return jsonb_build_object('errorCode', 'INVALID_SIMULATION_REQUEST');
  end if;
  -- One STABLE statement snapshot supplies revision, quantities and both engine runs.
  select coalesce(jsonb_agg(o order by o->>'id'), '[]'::jsonb) into rows from (
    select jsonb_build_object('id', t.id, 'documentId', t.document_id, 'orderId', t.order_id,
      'transactionType', t.transaction_type, 'units', t.units, 'currency', t.currency,
      'tradeDate', t.trade_date, 'details', t.details, 'symbol', t.asset_name,
      'identityKey', t.order_identity_key, 'signature', t.order_signature,
      'accountNumber', d.preview->'document'->>'accountNumber',
      'assetType', case d.preview->'document'->>'type'
        when 'DIME_OFFSHORE_CONFIRMATION_NOTE' then 'OFFSHORE_STOCK'
        when 'DIME_THAI_STOCK_CONFIRMATION_NOTE' then 'THAI_STOCK'
        when 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE' then 'MUTUAL_FUND' end,
      'exchange', case when d.preview->'document'->>'type' <> 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE'
        then nullif(t.details->>'exchange', '') end) o
    from public.investment_transactions t
    join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
    where t.user_id = p_user_id and d.status = 'IMPORTED' and not t.is_duplicate
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE',
        'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE')
    order by t.id limit 20001
  ) input;
  if jsonb_array_length(rows) > 20000 then return jsonb_build_object('errorCode', 'SIMULATION_ORDER_LIMIT_EXCEEDED'); end if;
  revision := 'sim-v1:' || md5(p_user_id::text || ':' || rows::text);
  if p_request ? 'expectedSnapshotRevision' and p_request->>'expectedSnapshotRevision' is distinct from revision then
    return jsonb_build_object('errorCode', 'SIMULATION_SNAPSHOT_CHANGED');
  end if;
  snapshot := public.get_stock_holdings(p_user_id, true);
  select h into position from jsonb_array_elements(snapshot->'items') h
    where h->>'assetType' = asset and h->>'symbol' = p_request->>'symbol' and h->>'currency' = ccy
      and h->>'accountNumber' is not distinct from p_request->>'accountNumber'
      and h->>'exchange' is not distinct from p_request->>'exchange';
  if position is null then return jsonb_build_object('errorCode', 'SIMULATION_POSITION_NOT_FOUND'); end if;
  if position->>'status' <> 'HELD' or (position->>'quantity')::numeric <= 0 then
    return jsonb_build_object('errorCode', 'SIMULATION_POSITION_NOT_HELD'); end if;
  if qty > (position->>'quantity')::numeric then
    return jsonb_build_object('errorCode', 'SIMULATION_QUANTITY_EXCEEDED'); end if;
  select c into before_cost from jsonb_array_elements(position->'costBasis') c where c->>'currency' = ccy;
  method := position->>'costBasisMethod'; source := position->>'costBasisSource';
  with collisions as (
    select x->>'identityKey' as key from jsonb_array_elements(rows) x where x->>'identityKey' is not null
    group by x->>'identityKey' having count(distinct x->>'signature') > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'orderId', o->>'orderId',
    'tradeDate', o->>'tradeDate', 'units', o->'units', 'assetType', asset, 'currency', ccy,
    'movement', case o->>'transactionType' when 'BUY' then 'BUY' when 'SUBSCRIPTION' then 'BUY'
      when 'SELL' then 'SELL' when 'REDEMPTION' then 'SELL' when 'SWITCH_IN' then 'SWITCH_IN'
      when 'SWITCH_OUT' then 'SWITCH_OUT' else o->>'transactionType' end,
    'grossAmount', o->'details'->'grossAmount', 'totalAmount', o->'details'->'totalAmount',
    'collision', c.key is not null) order by o->>'tradeDate', o->>'orderId', o->>'id'), '[]'::jsonb),
    max(o->>'tradeDate') into orders, last_date
    from jsonb_array_elements(rows) o left join collisions c on c.key = o->>'identityKey'
    where o->>'assetType' = asset and o->>'symbol' = p_request->>'symbol'
      and o->>'currency' = ccy and o->>'accountNumber' is not distinct from p_request->>'accountNumber'
      and o->>'exchange' is not distinct from p_request->>'exchange';
  if sim_date < last_date then return jsonb_build_object('errorCode', 'SIMULATION_DATE_BEFORE_SNAPSHOT'); end if;
  excluded := (position->>'excludedTransactionCount')::integer;
  collision := exists(select 1 from jsonb_array_elements(orders) o where (o->>'collision')::boolean);
  tolerance := case when asset <> 'MUTUAL_FUND' and excluded = 0 and not collision then 0.0000003::numeric end;
  raw_after := (position->>'rawQuantity')::numeric - qty;
  display_after := case when asset = 'MUTUAL_FUND' then raw_after else public.stock_display_quantity(
    raw_after, (position->>'boughtUnits')::numeric, (position->>'soldUnits')::numeric + qty, excluded, collision) end;
  proceeds := qty * price;
  -- Append only to an in-memory JSON array. Existing cost engines retain their
  -- ambiguity policy (same-day BUY+SELL / ambiguous Thai FIFO lot boundary).
  orders := orders || jsonb_build_array(jsonb_build_object('id', '~SIMULATED_SELL', 'orderId', '~SIMULATED_SELL',
    'tradeDate', sim_date, 'units', qty, 'movement', 'SELL', 'assetType', asset, 'currency', ccy,
    'grossAmount', case when asset = 'OFFSHORE_STOCK' then jsonb_build_object('foreign', proceeds, 'thb', null)
      else to_jsonb(proceeds) end, 'totalAmount', proceeds, 'collision', false));
  after_cost := case when asset = 'OFFSHORE_STOCK' then
      public.investment_compressed_fifo_cost(orders, ccy, raw_after, display_after, tolerance)
    when asset = 'THAI_STOCK' then public.investment_fifo_cost(orders, ccy, raw_after, display_after, tolerance)
    else public.investment_mutual_fund_average_cost(orders, raw_after, display_after) end;
  select coalesce(jsonb_agg(distinct issue), '[]'::jsonb) into issues from (
    select value as issue from jsonb_array_elements(coalesce(before_cost->'issues', '[]'::jsonb))
    union all select value from jsonb_array_elements(after_cost->'issues')
  ) all_issues;
  complete := coalesce(before_cost->>'status' = 'CALCULATED' and after_cost->>'status' = 'CALCULATED', false);
  if before_cost is null then issues := issues || '["COST_CURRENCY_REQUIRED"]'::jsonb; end if;
  if complete then
    cost_sold := (before_cost->>'remainingCost')::numeric - (after_cost->>'remainingCost')::numeric;
    pnl := proceeds - cost_sold;
    if cost_sold <> 0 then pct := pnl / cost_sold * 100;
    else issues := issues || '["ZERO_SOLD_COST_PERCENT_UNDEFINED"]'::jsonb; end if;
  end if;
  return jsonb_build_object('action', 'SELL', 'status', case when complete then 'CALCULATED' else 'INCOMPLETE' end,
    'isComplete', complete, 'persisted', false, 'assetType', asset, 'accountNumber', position->'accountNumber',
    'symbol', position->>'symbol', 'exchange', position->'exchange', 'currency', ccy, 'method', method,
    'source', source, 'tradeDate', sim_date, 'quantity', qty, 'price', price,
    'before', jsonb_build_object('quantity', position->'quantity', 'rawQuantity', position->'rawQuantity',
      'remainingCost', case when before_cost->>'status' = 'CALCULATED' then round((before_cost->>'remainingCost')::numeric, 8) end,
      'averageCostPerUnit', case when before_cost->>'status' = 'CALCULATED' then round((before_cost->>'averageCostPerUnit')::numeric, 8) end,
      'status', coalesce(before_cost->>'status', 'INCOMPLETE')),
    'after', jsonb_build_object('quantity', display_after, 'rawQuantity', raw_after,
      'remainingCost', case when complete then round((after_cost->>'remainingCost')::numeric, 8) end,
      'averageCostPerUnit', case when complete then round((after_cost->>'averageCostPerUnit')::numeric, 8) end,
      'rawRemainingCost', case when complete then after_cost->'rawRemainingCost' end,
      'roundingAdjusted', coalesce((after_cost->>'roundingAdjusted')::boolean, false),
      'status', case when complete then 'CALCULATED' else 'INCOMPLETE' end),
    'soldCost', round(cost_sold, 8), 'proceeds', round(proceeds, 8),
    'realizedPnl', round(pnl, 8), 'realizedPnlPercent', round(pct, 6), 'issues', issues,
    'feesIncluded', false, 'taxesIncluded', false, 'fxIncluded', false,
    'snapshot', jsonb_build_object('revision', revision, 'scope', 'IMPORTED_PORTFOLIO',
      'orderCount', jsonb_array_length(rows), 'positionLastTradeDate', last_date),
    'calculatedAt', statement_timestamp(), 'simulationVersion', 1,
    'assumptions', jsonb_build_object('basis', 'CURRENT_IMPORTED_POSITION', 'orderTiming', 'NO_INTRADAY_INFERENCE',
      'marketPriceSource', 'USER_INPUT', 'historicalReplay', false,
      'futureTradesAndCorporateActionsIncluded', false),
    'limitations', jsonb_build_array('HYPOTHETICAL_ONLY_NOT_A_TRADE_ORDER', 'FEES_TAXES_AND_FX_EXCLUDED',
      'NO_MARKET_LOT_OR_MINIMUM_ENFORCEMENT', 'PDF_COST_BASIS_NOT_BROKER_VERIFIED'));
end;
$$;
revoke all on function public.simulate_investment_sale(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.simulate_investment_sale(uuid, jsonb) to service_role;
commit;
