-- Run after 016. Offshore = Compressed FIFO; Thai = FIFO; funds = Average Cost.
-- Read existing gross values only; no transaction/table/column changes.
begin;
create or replace function public.investment_fifo_cost(
  p_orders jsonb, p_currency text, p_raw_quantity numeric, p_quantity numeric,
  p_tolerance numeric default null
) returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  day record;
  issues jsonb := '[]'::jsonb;
  lot_units numeric[] := '{}'::numeric[];
  lot_costs numeric[] := '{}'::numeric[];
  lot_dates text[] := '{}'::text[];
  head integer := 1;
  tail integer := 0;
  qty numeric := 0;
  basis numeric := 0;
  to_sell numeric;
  taken numeric;
  removed numeric;
  last_lot_average numeric;
  oversold numeric;
  raw_basis numeric;
  raw_average numeric;
  average numeric;
  adjusted boolean := false;
begin
  if exists(select 1 from jsonb_array_elements(p_orders) o where coalesce((o->>'collision')::boolean, false)) then
    issues := issues || '["ORDER_ID_COLLISION"]'::jsonb;
  end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o where coalesce(o->>'movement', '') not in ('BUY', 'SELL')) then
    issues := issues || '["UNSUPPORTED_COST_TRANSACTION"]'::jsonb;
  end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o where coalesce(o->>'tradeDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
    issues := issues || '["TRADE_DATE_REQUIRED"]'::jsonb;
  end if;
  -- Keep the existing safety policy: we have no execution times. The public
  -- daily-lot description alone does not establish mixed-day execution order.
  if exists(select 1 from jsonb_array_elements(p_orders) o group by o->>'tradeDate'
    having bool_or(o->>'movement' = 'BUY') and bool_or(o->>'movement' = 'SELL')) then
    issues := issues || '["INTRADAY_ORDER_AMBIGUOUS"]'::jsonb;
  end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o
    where case when jsonb_typeof(o->'units') = 'number' then (o->>'units')::numeric <= 0 else true end) then
    issues := issues || '["INVALID_COST_UNITS"]'::jsonb;
  end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o where o->>'movement' = 'BUY'
    and jsonb_typeof(o->'grossAmount')
      is distinct from 'number') then
    issues := issues || '["BUY_GROSS_REQUIRED"]'::jsonb;
  end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o where o->>'movement' = 'BUY'
    and case when jsonb_typeof(o->'grossAmount') = 'number'
      then (o->>'grossAmount')::numeric < 0 else false end) then
    issues := issues || '["INVALID_BUY_GROSS"]'::jsonb;
  end if;
  if jsonb_array_length(issues) = 0 then
    for day in
      select o->>'tradeDate' as trade_date, o->>'movement' as movement,
        (o->>'units')::numeric as units,
        case when o->>'movement' = 'BUY' then (o->>'grossAmount')::numeric end as gross
      from jsonb_array_elements(p_orders) with ordinality entries(o, idx)
      order by o->>'tradeDate', o->>'orderId', o->>'id', idx
    loop
      if day.movement = 'BUY' then
        if qty < 0 and p_tolerance is not null and abs(qty) <= p_tolerance then
          qty := 0; basis := 0; adjusted := true;
        end if;
        tail := tail + 1;
        lot_units[tail] := day.units;
        lot_costs[tail] := day.gross;
        lot_dates[tail] := day.trade_date;
        qty := qty + day.units; basis := basis + day.gross;
      else
        if qty <= 0 or (day.units > qty and (p_tolerance is null or day.units - qty > p_tolerance)) then
          issues := issues || '["SELL_EXCEEDS_AVAILABLE_UNITS"]'::jsonb; exit;
        end if;
        to_sell := least(day.units, qty);
        oversold := greatest(day.units - qty, 0);
        while to_sell > 0 loop
          if head > tail then issues := issues || '["COST_QUANTITY_MISMATCH"]'::jsonb; exit; end if;
          last_lot_average := lot_costs[head] / lot_units[head];
          taken := least(to_sell, lot_units[head]);
          removed := case when taken = lot_units[head] then lot_costs[head]
            else lot_costs[head] * taken / lot_units[head] end;
          lot_units[head] := lot_units[head] - taken;
          lot_costs[head] := lot_costs[head] - removed;
          basis := basis - removed;
          to_sell := to_sell - taken;
          if lot_units[head] = 0 then head := head + 1; end if;
        end loop;
        if jsonb_array_length(issues) > 0 then exit; end if;
        -- Retain the unrounded cost effect of a permitted tiny oversale for audit.
        if oversold > 0 then basis := basis - oversold * last_lot_average; end if;
        qty := qty - day.units;
      end if;
    end loop;
  end if;
  if jsonb_array_length(issues) = 0 and abs(qty - p_raw_quantity) > coalesce(p_tolerance, 0) then
    issues := issues || '["COST_QUANTITY_MISMATCH"]'::jsonb;
  end if;
  if jsonb_array_length(issues) > 0 then
    return jsonb_build_object('currency', p_currency, 'status', 'INCOMPLETE',
      'averageCostPerUnit', null, 'remainingCost', null, 'rawAverageCostPerUnit', null,
      'rawRemainingCost', null, 'quantity', p_quantity, 'roundingAdjusted', false, 'issues', issues);
  end if;
  -- Order IDs are deterministic tie-breakers, not proof of execution order.
  -- If the current FIFO boundary falls inside a date containing different-price
  -- purchases, do not expose an arbitrary lot ordering as a known cost.
  if exists(
    with bought as (
      select o->>'tradeDate' as date, sum((o->>'units')::numeric) as initial_units,
        count(distinct (o->>'grossAmount')::numeric / (o->>'units')::numeric) as prices
      from jsonb_array_elements(p_orders) o where o->>'movement' = 'BUY'
      group by o->>'tradeDate'
    ), remaining as (
      select dates.date, sum(dates.units) as remaining_units
      from unnest(lot_dates, lot_units) dates(date, units) group by dates.date
    )
    select 1 from bought b join remaining r on b.date = r.date
    where b.prices > 1 and r.remaining_units > 0 and r.remaining_units < b.initial_units
  ) then
    return jsonb_build_object('currency', p_currency, 'status', 'INCOMPLETE',
      'averageCostPerUnit', null, 'remainingCost', null, 'rawAverageCostPerUnit', null,
      'rawRemainingCost', null, 'quantity', p_quantity, 'roundingAdjusted', false,
      'issues', jsonb_build_array('INTRADAY_BUY_ORDER_AMBIGUOUS'));
  end if;
  raw_basis := basis;
  raw_average := case when qty <> 0 then basis / qty end;
  if p_quantity = 0 then
    adjusted := adjusted or qty <> 0;
    basis := 0; average := null;
  elsif qty > 0 then
    average := basis / qty;
    if qty <> p_quantity then basis := average * p_quantity; adjusted := true; end if;
  else
    return jsonb_build_object('currency', p_currency, 'status', 'INCOMPLETE',
      'averageCostPerUnit', null, 'remainingCost', null, 'rawAverageCostPerUnit', raw_average,
      'rawRemainingCost', raw_basis, 'quantity', p_quantity, 'roundingAdjusted', false,
      'issues', jsonb_build_array('SELL_EXCEEDS_AVAILABLE_UNITS'));
  end if;
  return jsonb_build_object('currency', p_currency, 'status', 'CALCULATED',
    'averageCostPerUnit', average, 'remainingCost', basis,
    'rawAverageCostPerUnit', raw_average, 'rawRemainingCost', raw_basis,
    'quantity', p_quantity, 'roundingAdjusted', adjusted,
    'issues', case when adjusted then jsonb_build_array('ROUNDING_CLOSURE_ESTIMATE') else '[]'::jsonb end);
end;
$$;
revoke all on function public.investment_fifo_cost(jsonb, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.investment_fifo_cost(jsonb, text, numeric, numeric, numeric) to service_role;

create or replace function public.get_stock_holdings(p_user_id uuid, p_include_closed boolean default false)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with imported_orders as (
    select t.id, t.transaction_type, t.units, t.currency, t.details, t.trade_date, t.order_id, t.asset_name as symbol,
      t.order_identity_key, t.order_signature,
      d.preview->'document'->>'accountNumber' as account_number,
      case d.preview->'document'->>'type'
        when 'DIME_OFFSHORE_CONFIRMATION_NOTE' then 'OFFSHORE_STOCK'
        when 'DIME_THAI_STOCK_CONFIRMATION_NOTE' then 'THAI_STOCK'
        when 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE' then 'MUTUAL_FUND' end as asset_type,
      case when d.preview->'document'->>'type' = 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE'
        then null else nullif(t.details->>'exchange', '') end as exchange
    from public.investment_transactions t
    join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
    where t.user_id = p_user_id and d.status = 'IMPORTED' and not t.is_duplicate
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE')
  ), classified as (
    select *, case when asset_type = 'MUTUAL_FUND' then
      case transaction_type when 'SUBSCRIPTION' then 'BUY' when 'REDEMPTION' then 'SELL'
        when 'SWITCH_IN' then 'SWITCH_IN' when 'SWITCH_OUT' then 'SWITCH_OUT' end
      else case transaction_type when 'BUY' then 'BUY' when 'SELL' then 'SELL' end
    end as movement from imported_orders
  ), collisions as (
    select order_identity_key from imported_orders where order_identity_key is not null
    group by order_identity_key having count(distinct order_signature) > 1
  ), marked_orders as (
    select s.*, (c.order_identity_key is not null) as has_order_collision
    from classified s left join collisions c on c.order_identity_key = s.order_identity_key
  ), grouped as (
    select asset_type, account_number, symbol, exchange, currency,
      coalesce(sum(units) filter (where movement = 'BUY'), 0) as bought,
      coalesce(sum(units) filter (where movement = 'SELL'), 0) as sold,
      coalesce(sum(units) filter (where movement = 'SWITCH_IN'), 0) as switched_in,
      coalesce(sum(units) filter (where movement = 'SWITCH_OUT'), 0) as switched_out,
      count(*) filter (where movement is not null) as included_count,
      count(*) filter (where movement is null) as excluded_count,
      bool_or(has_order_collision) as has_collision,
      jsonb_agg(jsonb_build_object('id', id, 'orderId', order_id, 'tradeDate', trade_date,
        'units', units, 'movement', movement, 'assetType', asset_type,
        'grossAmount', details->'grossAmount', 'collision', has_order_collision)) as cost_orders,
      public.investment_amount_summary(jsonb_agg(jsonb_build_object(
        'movement', movement, 'currency', currency, 'assetType', asset_type,
        'totalAmount', details->'totalAmount', 'grossAmount', details->'grossAmount',
        'feeIncludeVat', details->'feeIncludeVat', 'feeExcludeVat', details->'feeExcludeVat', 'vat', details->'vat'))) as amounts
    from marked_orders group by asset_type, account_number, symbol, exchange, currency
  ), raw_positions as (
    select *, bought + switched_in - sold - switched_out as raw_quantity from grouped where included_count > 0
  ), display_positions as (
    select *, case when asset_type = 'MUTUAL_FUND' then raw_quantity
      else public.stock_display_quantity(raw_quantity, bought, sold, excluded_count, has_collision)
    end as quantity from raw_positions
  ), positions as (
    select d.*, (select jsonb_agg((
      case when d.asset_type = 'OFFSHORE_STOCK' then public.investment_compressed_fifo_cost(
        d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
        case when d.excluded_count = 0 and not d.has_collision then 0.0000003::numeric end)
      when d.asset_type = 'THAI_STOCK' then public.investment_fifo_cost(
        d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
        case when d.excluded_count = 0 and not d.has_collision then 0.0000003::numeric end)
      else public.investment_average_cost(
        d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
        case when d.asset_type <> 'MUTUAL_FUND' and d.excluded_count = 0 and not d.has_collision
          then 0.0000003::numeric end) end
    ) || jsonb_build_object('method', case when d.asset_type = 'OFFSHORE_STOCK'
      then 'COMPRESSED_FIFO' when d.asset_type = 'THAI_STOCK' then 'FIFO' else 'MOVING_WEIGHTED_AVERAGE' end) order by cost_currency)
      from (values ('THB'), (case when d.asset_type = 'OFFSHORE_STOCK' and d.currency <> 'THB' then d.currency end)) currencies(cost_currency)
      where cost_currency is not null) as cost_basis
    from display_positions d
  ), omitted as (
    select asset_type, account_number, symbol, transaction_type, count(*) as count
    from classified where movement is null group by asset_type, account_number, symbol, transaction_type
  )
  select jsonb_build_object(
    'scope', 'STOCKS_AND_MUTUAL_FUNDS', 'calculatedAt', now(), 'includeClosed', p_include_closed,
    'roundingTolerance', 0.0000003::numeric,
    'roundingAppliesTo', jsonb_build_array('OFFSHORE_STOCK', 'THAI_STOCK'),
    'roundingAdjustedCount', (select count(*) from positions where quantity <> raw_quantity),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'fundName', case when asset_type = 'MUTUAL_FUND' then symbol else null end,
      'exchange', exchange, 'currency', currency, 'boughtUnits', bought, 'soldUnits', sold,
      'switchInUnits', switched_in, 'switchOutUnits', switched_out,
      'acquiredUnits', bought + switched_in, 'disposedUnits', sold + switched_out,
      'rawQuantity', raw_quantity, 'quantity', quantity, 'roundingAdjusted', quantity <> raw_quantity,
      'roundingTolerance', case when asset_type = 'MUTUAL_FUND' then null else 0.0000003::numeric end,
      'transactionCount', included_count, 'excludedTransactionCount', excluded_count,
      'amounts', amounts, 'costBasis', cost_basis,
      'costBasisMethod', case when asset_type = 'OFFSHORE_STOCK' then 'COMPRESSED_FIFO' when asset_type = 'THAI_STOCK' then 'FIFO' else 'MOVING_WEIGHTED_AVERAGE' end,
      'costBasisOrder', case when asset_type = 'OFFSHORE_STOCK' then 'TRADE_DATE_DAILY_LOTS' when asset_type = 'THAI_STOCK' then 'TRADE_DATE_INDIVIDUAL_LOTS' else 'TRADE_DATE_NO_INTRADAY_INFERENCE' end,
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'costBasisMethod', 'BY_ASSET_TYPE',
    'costBasisMethods', jsonb_build_object('OFFSHORE_STOCK', 'COMPRESSED_FIFO',
      'THAI_STOCK', 'FIFO', 'MUTUAL_FUND', 'MOVING_WEIGHTED_AVERAGE'),
    'costBasisGroupingDate', 'TRADE_DATE_AS_PARSED',
    'costBasisSource', 'GROSS_AMOUNT_EXCLUDING_FEES',
    'costBasisOrder', 'TRADE_DATE_NO_INTRADAY_INFERENCE',
    'costBasisTotalsScope', 'ALL_IMPORTED_POSITIONS_INCLUDING_CLOSED',
    'remainingCostTotals', (select public.investment_remaining_cost_totals(jsonb_agg(c))
      from positions cross join lateral jsonb_array_elements(cost_basis) c),
    'stockRemainingCostTotals', (select public.investment_remaining_cost_totals(jsonb_agg(c))
      from positions cross join lateral jsonb_array_elements(cost_basis) c
      where asset_type in ('OFFSHORE_STOCK', 'THAI_STOCK')),
    'moneySource', 'IMPORTED_ORDER_TOTALS',
    'grossSource', 'PDF_ORDER_GROSS_AMOUNT',
    'feeSource', 'PDF_ORDER_FEES_INCLUDE_VAT_BEFORE_DOCUMENT_DISCOUNTS',
    'documentDiscountsApplied', false,
    'stockMoneyTotalsScope', 'ALL_IMPORTED_STOCK_BUY_SELL_INCLUDING_CLOSED',
    'stockMoneyTotals', (select public.investment_amount_summary(jsonb_agg(jsonb_build_object(
      'movement', movement, 'currency', currency, 'assetType', asset_type,
      'totalAmount', details->'totalAmount', 'grossAmount', details->'grossAmount',
      'feeIncludeVat', details->'feeIncludeVat', 'feeExcludeVat', details->'feeExcludeVat', 'vat', details->'vat')))
      from marked_orders where asset_type in ('OFFSHORE_STOCK', 'THAI_STOCK')),
    'moneyTotalsScope', 'ALL_IMPORTED_SUPPORTED_ORDERS_INCLUDING_CLOSED',
    'moneyTotals', (select public.investment_amount_summary(jsonb_agg(jsonb_build_object(
      'movement', movement, 'currency', currency, 'assetType', asset_type,
      'totalAmount', details->'totalAmount', 'grossAmount', details->'grossAmount',
        'feeIncludeVat', details->'feeIncludeVat', 'feeExcludeVat', details->'feeExcludeVat', 'vat', details->'vat'))) from marked_orders),
    'moneyLimitations', jsonb_build_array('HISTORICAL_PDF_AMOUNTS_NOT_LIVE_FX',
      'NET_CASH_FLOW_IS_NOT_REMAINING_COST_OR_PROFIT', 'DOCUMENT_LEVEL_DISCOUNTS_NOT_ALLOCATED',
      'CONFIRMATIONS_ONLY_HISTORY_MAY_BE_INCOMPLETE', 'MUTUAL_FUND_GROSS_MAY_BE_UNAVAILABLE',
      'FEE_TOTALS_EXCLUDE_WITHHOLDING_TAX'),
    'excludedTransactions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'transactionType', transaction_type, 'count', count
    ) order by asset_type, symbol, account_number, transaction_type) from omitted), '[]'::jsonb),
    'limitations', jsonb_build_array('SUPPORTED_TRANSACTIONS_ONLY', 'NO_MARKET_VALUE', 'STOCK_ROUNDING_CLOSURE_IS_AN_ESTIMATE'),
    'duplicateOrdersExcluded', (select count(*) from public.investment_transactions t
      join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
      where t.user_id = p_user_id and t.is_duplicate and d.status = 'IMPORTED'
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE')),
    'warnings',
      (case when exists(select 1 from omitted) then jsonb_build_array(jsonb_build_object('code', 'SPECIAL_TRANSACTIONS_EXCLUDED', 'message', 'Unsupported transaction types are not included in quantities')) else '[]'::jsonb end)
      || (case when exists(select 1 from positions where quantity < 0) then jsonb_build_array(jsonb_build_object('code', 'NEGATIVE_HOLDINGS', 'message', 'Disposed quantities exceed imported acquired quantities; history may be incomplete')) else '[]'::jsonb end)
      || (case when exists(select 1 from collisions) then jsonb_build_array(jsonb_build_object('code', 'ORDER_ID_COLLISION', 'message', 'Historical orders share an ID but have different values; review required')) else '[]'::jsonb end)
  );
$$;
revoke all on function public.get_stock_holdings(uuid, boolean) from public, anon, authenticated;
grant execute on function public.get_stock_holdings(uuid, boolean) to service_role;
commit;
