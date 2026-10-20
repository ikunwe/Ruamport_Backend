-- Requires 007-014. Moving weighted average using historical PDF gross, excluding fees.
-- No tables/columns or stored transactions are changed.
begin;
create or replace function public.investment_average_cost(
  p_orders jsonb, p_currency text, p_raw_quantity numeric, p_quantity numeric,
  p_tolerance numeric default null
) returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  item jsonb;
  issues jsonb := '[]'::jsonb;
  qty numeric := 0;
  basis numeric := 0;
  units numeric;
  gross numeric;
  average numeric;
  raw_basis numeric;
  raw_average numeric;
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
  -- No intraday timestamp exists in stored confirmation rows. Never infer
  -- execution order from PDF upload order, UUID, or lexicographic order IDs.
  if exists(select 1 from jsonb_array_elements(p_orders) o
    group by o->>'tradeDate' having bool_or(o->>'movement' = 'BUY') and bool_or(o->>'movement' = 'SELL')) then
    issues := issues || '["INTRADAY_ORDER_AMBIGUOUS"]'::jsonb;
  end if;
  if jsonb_array_length(issues) = 0 then
    for item in select o from jsonb_array_elements(p_orders) o
      order by o->>'tradeDate', o->>'orderId', o->>'id'
    loop
      if jsonb_typeof(item->'units') is distinct from 'number' then
        issues := issues || '["INVALID_COST_UNITS"]'::jsonb; exit;
      end if;
      units := (item->>'units')::numeric;
      if units <= 0 then issues := issues || '["INVALID_COST_UNITS"]'::jsonb; exit; end if;
      if item->>'movement' = 'BUY' then
        if item->>'assetType' = 'OFFSHORE_STOCK' then
          if p_currency = 'THB' then item := jsonb_set(item, '{costGross}', coalesce(item->'grossAmount'->'thb', 'null'::jsonb));
          else item := jsonb_set(item, '{costGross}', coalesce(item->'grossAmount'->'foreign', 'null'::jsonb)); end if;
        else item := jsonb_set(item, '{costGross}', coalesce(item->'grossAmount', 'null'::jsonb)); end if;
        if jsonb_typeof(item->'costGross') is distinct from 'number' then
          issues := issues || '["BUY_GROSS_REQUIRED"]'::jsonb; exit;
        end if;
        gross := (item->>'costGross')::numeric;
        if gross < 0 then issues := issues || '["INVALID_BUY_GROSS"]'::jsonb; exit; end if;
        -- An estimated tiny oversale closed a previous cycle. Reopening starts
        -- at zero; raw transaction quantities remain untouched in storage.
        if qty < 0 and p_tolerance is not null and abs(qty) <= p_tolerance then
          qty := 0; basis := 0; adjusted := true;
        end if;
        qty := qty + units;
        basis := basis + gross;
      else
        if qty <= 0 or (units > qty and (p_tolerance is null or units - qty > p_tolerance)) then
          issues := issues || '["SELL_EXCEEDS_AVAILABLE_UNITS"]'::jsonb; exit;
        end if;
        average := basis / qty;
        if units = qty then basis := 0;
        else basis := basis - units * average; end if;
        qty := qty - units;
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
  raw_basis := basis;
  raw_average := case when qty <> 0 then basis / qty end;
  if p_quantity = 0 then
    adjusted := adjusted or qty <> 0;
    basis := 0; average := null;
  elsif qty > 0 then
    average := basis / qty;
    if qty <> p_quantity then
      -- Align a reopened cycle with the audited holdings quantity only inside
      -- the previously checked tolerance. Preserve the unadjusted basis above.
      basis := average * p_quantity; adjusted := true;
    end if;
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
revoke all on function public.investment_average_cost(jsonb, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.investment_average_cost(jsonb, text, numeric, numeric, numeric) to service_role;

create or replace function public.investment_remaining_cost_totals(p_costs jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  with grouped as (
    select c->>'currency' as currency, count(*) as position_count,
      count(*) filter (where c->>'status' is distinct from 'CALCULATED'
        or jsonb_typeof(c->'remainingCost') is distinct from 'number') as incomplete_count,
      sum(case when jsonb_typeof(c->'remainingCost') = 'number' then (c->>'remainingCost')::numeric end) as cost
    from jsonb_array_elements(coalesce(p_costs, '[]'::jsonb)) c group by c->>'currency'
  )
  select coalesce(jsonb_agg(jsonb_build_object('currency', currency,
    'remainingCost', case when incomplete_count = 0 then cost end,
    'isComplete', incomplete_count = 0, 'positionCount', position_count,
    'incompletePositionCount', incomplete_count) order by currency), '[]'::jsonb) from grouped;
$$;
revoke all on function public.investment_remaining_cost_totals(jsonb) from public, anon, authenticated;
grant execute on function public.investment_remaining_cost_totals(jsonb) to service_role;

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
    select d.*, (select jsonb_agg(public.investment_average_cost(
      d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
      case when d.asset_type <> 'MUTUAL_FUND' and d.excluded_count = 0 and not d.has_collision
        then 0.0000003::numeric end
    ) order by cost_currency)
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
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'costBasisMethod', 'MOVING_WEIGHTED_AVERAGE',
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
