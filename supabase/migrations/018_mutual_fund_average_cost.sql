-- Run after 017. Funds use existing PDF Total Amount as unit-investment value.
-- Fee Include VAT is a separate PDF column; never deduct/add it to this cost.
-- Read-only normalization: do not alter previews, details, or dedup signatures.
begin;
create or replace function public.investment_mutual_fund_average_cost(
  p_orders jsonb, p_raw_quantity numeric, p_quantity numeric
) returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  normalized jsonb;
  result jsonb;
  issues jsonb;
begin
  if exists(select 1 from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) o
    where o->>'currency' is distinct from 'THB') then
    return jsonb_build_object('currency', 'THB', 'status', 'INCOMPLETE',
      'averageCostPerUnit', null, 'remainingCost', null,
      'rawAverageCostPerUnit', null, 'rawRemainingCost', null,
      'quantity', p_quantity, 'roundingAdjusted', false,
      'source', 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES', 'feesIncluded', false,
      'issues', jsonb_build_array('COST_CURRENCY_UNSUPPORTED'));
  end if;
  select coalesce(jsonb_agg(o || jsonb_build_object('grossAmount', o->'totalAmount')), '[]'::jsonb)
    into normalized from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) o;
  result := public.investment_average_cost(normalized, 'THB', p_raw_quantity, p_quantity, null);
  select coalesce(jsonb_agg(case value #>> '{}' when 'BUY_GROSS_REQUIRED' then 'BUY_AMOUNT_REQUIRED'
    when 'INVALID_BUY_GROSS' then 'INVALID_BUY_AMOUNT' else value #>> '{}' end), '[]'::jsonb)
    into issues from jsonb_array_elements(result->'issues');
  return result || jsonb_build_object('source', 'PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES',
    'feesIncluded', false, 'issues', issues);
end;
$$;
revoke all on function public.investment_mutual_fund_average_cost(jsonb, numeric, numeric) from public, anon, authenticated;
grant execute on function public.investment_mutual_fund_average_cost(jsonb, numeric, numeric) to service_role;

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
  ), positions as (
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
