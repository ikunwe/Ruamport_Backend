-- Add historical per-order monetary totals; do not change stored transactions.
-- Requires 007-012. All arithmetic is PostgreSQL numeric, never JS floating point.
begin;

create or replace function public.investment_amount_summary(p_orders jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  with orders as (
    select item->>'movement' as movement, item->>'currency' as currency,
      item->>'assetType' as asset_type, item->'totalAmount' as total_amount
    from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) item
    where item->>'movement' in ('BUY', 'SELL', 'SWITCH_IN', 'SWITCH_OUT')
  ), entries as (
    -- Native offshore amount, not a conversion at today's FX.
    select movement, currency,
      case when jsonb_typeof(total_amount->'foreign') = 'number'
        then (total_amount->>'foreign')::numeric end as amount
    from orders where asset_type = 'OFFSHORE_STOCK' and currency is not null and currency <> 'THB'
    union all
    select movement, 'THB',
      case when asset_type = 'OFFSHORE_STOCK' then
        case when jsonb_typeof(total_amount->'thb') = 'number' then (total_amount->>'thb')::numeric end
      else case when currency = 'THB' and jsonb_typeof(total_amount) = 'number'
        then total_amount::text::numeric end end
    from orders
  ), grouped as (
    select currency,
      case when count(*) filter (where movement = 'BUY' and amount is null) = 0
        then coalesce(sum(amount) filter (where movement = 'BUY'), 0) end as bought,
      case when count(*) filter (where movement = 'SELL' and amount is null) = 0
        then coalesce(sum(amount) filter (where movement = 'SELL'), 0) end as sold,
      case when count(*) filter (where movement = 'SWITCH_IN' and amount is null) = 0
        then coalesce(sum(amount) filter (where movement = 'SWITCH_IN'), 0) end as switched_in,
      case when count(*) filter (where movement = 'SWITCH_OUT' and amount is null) = 0
        then coalesce(sum(amount) filter (where movement = 'SWITCH_OUT'), 0) end as switched_out,
      count(*) as order_count, count(*) filter (where amount is null) as missing_count
    from entries group by currency
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', currency, 'totalBuy', bought, 'totalSell', sold,
    'totalSwitchIn', switched_in, 'totalSwitchOut', switched_out,
    'netBuySellCashFlow', bought - sold,
    'orderCount', order_count, 'missingAmountCount', missing_count,
    'isComplete', missing_count = 0
  ) order by currency), '[]'::jsonb) from grouped;
$$;
revoke all on function public.investment_amount_summary(jsonb) from public, anon, authenticated;
grant execute on function public.investment_amount_summary(jsonb) to service_role;

create or replace function public.get_stock_holdings(p_user_id uuid, p_include_closed boolean default false)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with imported_orders as (
    select t.id, t.transaction_type, t.units, t.currency, t.details, t.asset_name as symbol,
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
      public.investment_amount_summary(jsonb_agg(jsonb_build_object(
        'movement', movement, 'currency', currency, 'assetType', asset_type,
        'totalAmount', details->'totalAmount'))) as amounts
    from marked_orders group by asset_type, account_number, symbol, exchange, currency
  ), raw_positions as (
    select *, bought + switched_in - sold - switched_out as raw_quantity from grouped where included_count > 0
  ), positions as (
    select *, case when asset_type = 'MUTUAL_FUND' then raw_quantity
      else public.stock_display_quantity(raw_quantity, bought, sold, excluded_count, has_collision)
    end as quantity from raw_positions
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
      'amounts', amounts,
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'moneySource', 'IMPORTED_ORDER_TOTALS',
    'moneyTotalsScope', 'ALL_IMPORTED_SUPPORTED_ORDERS_INCLUDING_CLOSED',
    'moneyTotals', (select public.investment_amount_summary(jsonb_agg(jsonb_build_object(
      'movement', movement, 'currency', currency, 'assetType', asset_type,
      'totalAmount', details->'totalAmount'))) from marked_orders),
    'moneyLimitations', jsonb_build_array('HISTORICAL_PDF_AMOUNTS_NOT_LIVE_FX',
      'NET_CASH_FLOW_IS_NOT_REMAINING_COST_OR_PROFIT', 'DOCUMENT_LEVEL_DISCOUNTS_NOT_ALLOCATED',
      'CONFIRMATIONS_ONLY_HISTORY_MAY_BE_INCOMPLETE'),
    'excludedTransactions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'transactionType', transaction_type, 'count', count
    ) order by asset_type, symbol, account_number, transaction_type) from omitted), '[]'::jsonb),
    'limitations', jsonb_build_array('SUPPORTED_TRANSACTIONS_ONLY', 'NO_COST_OR_MARKET_VALUE', 'STOCK_ROUNDING_CLOSURE_IS_AN_ESTIMATE'),
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


