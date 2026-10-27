-- Local migration file only: NOT applied to any live database by this task.
-- Additive response fields; copies migration 018 holdings query without changing its filters,
-- ownership, quantities, cost methods or old fields. No data writes or table changes.
-- Run after 018, following isolated verify-investment-sql.cjs validation.
begin;
create or replace function public.investment_realized_pnl(p_orders jsonb, p_cost jsonb, p_asset_type text)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  o jsonb; amount jsonb; ccy text := p_cost->>'currency';
  buy_total numeric := 0; sell_total numeric := 0;
  buy_missing boolean := false; sell_missing boolean := false;
  disposed_cost numeric; profit numeric;
  issues jsonb := coalesce(p_cost->'issues', '[]'::jsonb);
  complete boolean;
begin
  for o in select value from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    if coalesce(o->>'movement', '') not in ('BUY', 'SELL') then continue; end if;
    if p_asset_type = 'MUTUAL_FUND' then
      amount := case when ccy = 'THB' and o->>'currency' = 'THB' then o->'totalAmount' end;
    elsif p_asset_type = 'OFFSHORE_STOCK' then
      amount := case when ccy = 'THB' then o->'grossAmount'->'thb'
        when ccy = o->>'currency' then o->'grossAmount'->'foreign' end;
    else
      amount := case when ccy = 'THB' then o->'grossAmount' end;
    end if;
    if jsonb_typeof(amount) is distinct from 'number' then
      if o->>'movement' = 'BUY' then buy_missing := true; else sell_missing := true; end if;
    elsif (amount #>> '{}')::numeric < 0 then
      if o->>'movement' = 'BUY' then buy_missing := true; else sell_missing := true; end if;
    elsif o->>'movement' = 'BUY' then buy_total := buy_total + (amount #>> '{}')::numeric;
    else sell_total := sell_total + (amount #>> '{}')::numeric;
    end if;
  end loop;
  if buy_missing then issues := issues || '["BUY_VALUE_REQUIRED"]'::jsonb; end if;
  if sell_missing then issues := issues || '["SELL_VALUE_REQUIRED"]'::jsonb; end if;
  complete := coalesce(p_cost->>'status' = 'CALCULATED'
    and jsonb_typeof(p_cost->'remainingCost') = 'number', false) and not buy_missing and not sell_missing;
  if complete then
    disposed_cost := buy_total - (p_cost->>'remainingCost')::numeric;
    profit := sell_total - disposed_cost;
  end if;
  return jsonb_build_object('currency', ccy, 'status', case when complete then 'CALCULATED' else 'INCOMPLETE' end,
    'totalBuyValue', case when not buy_missing then buy_total end,
    'totalSellValue', case when not sell_missing then sell_total end,
    'soldCost', case when complete then disposed_cost end,
    'realizedPnl', case when complete then profit end,
    'method', p_cost->>'method', 'source', p_cost->>'source',
    'feesIncluded', false, 'taxesIncluded', false,
    'roundingAdjusted', coalesce((p_cost->>'roundingAdjusted')::boolean, false), 'issues', issues);
end;
$$;
revoke all on function public.investment_realized_pnl(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.investment_realized_pnl(jsonb, jsonb, text) to service_role;
create or replace function public.investment_realized_pnl_totals(p_rows jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  with grouped as (
    select r->>'currency' as currency, count(*) as position_count,
      count(*) filter (where r->>'status' is distinct from 'CALCULATED'
        or jsonb_typeof(r->'soldCost') is distinct from 'number'
        or jsonb_typeof(r->'realizedPnl') is distinct from 'number') as incomplete_count,
      sum((r->>'soldCost')::numeric) as sold_cost, sum((r->>'realizedPnl')::numeric) as pnl
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r group by r->>'currency'
  )
  select coalesce(jsonb_agg(jsonb_build_object('currency', currency,
    'soldCost', case when incomplete_count = 0 then sold_cost end,
    'realizedPnl', case when incomplete_count = 0 then pnl end,
    'isComplete', incomplete_count = 0, 'positionCount', position_count,
    'incompletePositionCount', incomplete_count, 'feesIncluded', false, 'taxesIncluded', false)
    order by currency), '[]'::jsonb) from grouped;
$$;
revoke all on function public.investment_realized_pnl_totals(jsonb) from public, anon, authenticated;
grant execute on function public.investment_realized_pnl_totals(jsonb) to service_role;

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
        'currency', currency, 'totalAmount', details->'totalAmount',
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
  ), cost_positions as (
    select d.*, (select jsonb_agg((
      case when d.asset_type = 'OFFSHORE_STOCK' then public.investment_compressed_fifo_cost(
        d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
        case when d.excluded_count = 0 and not d.has_collision then 0.0000003::numeric end)
      when d.asset_type = 'THAI_STOCK' then public.investment_fifo_cost(
        d.cost_orders, cost_currency, d.raw_quantity, d.quantity,
        case when d.excluded_count = 0 and not d.has_collision then 0.0000003::numeric end)
      else public.investment_mutual_fund_average_cost(
        d.cost_orders, d.raw_quantity, d.quantity) end
    ) || jsonb_build_object('method', case when d.asset_type = 'OFFSHORE_STOCK'
      then 'COMPRESSED_FIFO' when d.asset_type = 'THAI_STOCK' then 'FIFO' else 'MOVING_WEIGHTED_AVERAGE' end,
      'source', case when d.asset_type = 'MUTUAL_FUND' then 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES' else 'PDF_ORDER_GROSS_AMOUNT' end,
      'feesIncluded', false) order by cost_currency)
      from (values ('THB'), (case when d.asset_type = 'OFFSHORE_STOCK' and d.currency <> 'THB' then d.currency end)) currencies(cost_currency)
      where cost_currency is not null) as cost_basis
    from display_positions d
  ), positions as (
    select p.*, (select jsonb_agg(public.investment_realized_pnl(p.cost_orders, c, p.asset_type)
      order by c->>'currency') from jsonb_array_elements(p.cost_basis) c) as realized_pnl
    from cost_positions p
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
      'amounts', amounts, 'costBasis', cost_basis, 'realizedPnl', realized_pnl,
      'costBasisSource', case when asset_type = 'MUTUAL_FUND' then 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES' else 'PDF_ORDER_GROSS_AMOUNT' end,
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
    'costBasisSources', jsonb_build_object('OFFSHORE_STOCK', 'PDF_ORDER_GROSS_AMOUNT',
      'THAI_STOCK', 'PDF_ORDER_GROSS_AMOUNT', 'MUTUAL_FUND', 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES'),
    'costBasisOrder', 'TRADE_DATE_NO_INTRADAY_INFERENCE',
    'costBasisTotalsScope', 'ALL_IMPORTED_POSITIONS_INCLUDING_CLOSED',
    'remainingCostTotals', (select public.investment_remaining_cost_totals(jsonb_agg(c))
      from positions cross join lateral jsonb_array_elements(cost_basis) c),
    'stockRemainingCostTotals', (select public.investment_remaining_cost_totals(jsonb_agg(c))
      from positions cross join lateral jsonb_array_elements(cost_basis) c
      where asset_type in ('OFFSHORE_STOCK', 'THAI_STOCK')),
    'realizedPnlSource', 'HISTORICAL_PDF_VALUES_MINUS_DISPOSED_COST',
    'realizedPnlTotalsScope', 'ALL_IMPORTED_POSITIONS_INCLUDING_CLOSED',
    'realizedPnlLimitations', jsonb_build_array('BEFORE_FEES_TAXES_AND_DISCOUNTS',
      'HISTORICAL_PDF_CURRENCIES_NOT_CURRENT_FX', 'CONFIRMATION_HISTORY_MAY_BE_INCOMPLETE',
      'ROUNDING_FOLLOWS_COST_BASIS', 'NOT_TAX_REPORTING'),
    'realizedPnlTotals', (select public.investment_realized_pnl_totals(jsonb_agg(r))
      from positions cross join lateral jsonb_array_elements(realized_pnl) r),
    'stockRealizedPnlTotals', (select public.investment_realized_pnl_totals(jsonb_agg(r))
      from positions cross join lateral jsonb_array_elements(realized_pnl) r
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

