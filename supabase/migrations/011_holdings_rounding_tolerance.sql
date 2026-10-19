-- Display-only closure tolerance. Never change stored transaction units.
-- Must run after 010 so order-level deduplication remains in effect.
begin;
create or replace function public.stock_display_quantity(
  p_raw numeric, p_bought numeric, p_sold numeric, p_excluded bigint, p_collision boolean default false
) returns numeric language sql immutable security invoker set search_path = '' as $$
  select case when p_raw <> 0 and abs(p_raw) <= 0.0000003::numeric
    and p_bought > 0 and p_sold > 0 and p_excluded = 0 and not p_collision
    then 0::numeric else p_raw end;
$$;

create or replace function public.get_stock_holdings(p_user_id uuid, p_include_closed boolean default false)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with stock_orders as (
    select t.id, t.transaction_type, t.units, t.currency, t.asset_name as symbol,
      t.order_identity_key, t.order_signature,
      d.preview->'document'->>'accountNumber' as account_number,
      case d.preview->'document'->>'type'
        when 'DIME_OFFSHORE_CONFIRMATION_NOTE' then 'OFFSHORE_STOCK'
        when 'DIME_THAI_STOCK_CONFIRMATION_NOTE' then 'THAI_STOCK' end as asset_type,
      nullif(t.details->>'exchange', '') as exchange
    from public.investment_transactions t
    join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
    where t.user_id = p_user_id and d.status = 'IMPORTED' and not t.is_duplicate
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE')
  ), collisions as (
    select order_identity_key from stock_orders where order_identity_key is not null
    group by order_identity_key having count(distinct order_signature) > 1
  ), marked_orders as (
    select s.*, (c.order_identity_key is not null) as has_order_collision
    from stock_orders s left join collisions c on c.order_identity_key = s.order_identity_key
  ), grouped as (
    select asset_type, account_number, symbol, exchange, currency,
      coalesce(sum(units) filter (where transaction_type = 'BUY'), 0) as bought,
      coalesce(sum(units) filter (where transaction_type = 'SELL'), 0) as sold,
      count(*) filter (where transaction_type in ('BUY', 'SELL')) as included_count,
      count(*) filter (where transaction_type not in ('BUY', 'SELL')) as excluded_count,
      bool_or(has_order_collision) as has_collision
    from marked_orders group by asset_type, account_number, symbol, exchange, currency
  ), raw_positions as (
    select *, bought - sold as raw_quantity from grouped where included_count > 0
  ), positions as (
    select *, public.stock_display_quantity(raw_quantity, bought, sold, excluded_count, has_collision) as quantity
    from raw_positions
  ), omitted as (
    select asset_type, account_number, symbol, transaction_type, count(*) as count
    from stock_orders where transaction_type not in ('BUY', 'SELL')
    group by asset_type, account_number, symbol, transaction_type
  )
  select jsonb_build_object(
    'scope', 'STOCK_BUY_SELL_ONLY', 'calculatedAt', now(), 'includeClosed', p_include_closed,
    'roundingTolerance', 0.0000003::numeric,
    'roundingAdjustedCount', (select count(*) from positions where quantity <> raw_quantity),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'exchange', exchange, 'currency', currency, 'boughtUnits', bought, 'soldUnits', sold,
      'rawQuantity', raw_quantity, 'quantity', quantity, 'roundingAdjusted', quantity <> raw_quantity,
      'transactionCount', included_count, 'excludedTransactionCount', excluded_count,
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'excludedTransactions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'transactionType', transaction_type, 'count', count
    ) order by asset_type, symbol, account_number, transaction_type) from omitted), '[]'::jsonb),
    'limitations', jsonb_build_array('BUY_SELL_ONLY', 'MUTUAL_FUNDS_EXCLUDED', 'NO_COST_OR_MARKET_VALUE', 'ROUNDING_CLOSURE_IS_AN_ESTIMATE'),
    'duplicateOrdersExcluded', (select count(*) from public.investment_transactions t
      join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
      where t.user_id = p_user_id and t.is_duplicate and d.status = 'IMPORTED'
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE')),
    'warnings',
      (case when exists(select 1 from omitted) then jsonb_build_array(jsonb_build_object('code', 'SPECIAL_TRANSACTIONS_EXCLUDED', 'message', 'Stock rewards and option exercises are not included in quantities yet')) else '[]'::jsonb end)
      || (case when exists(select 1 from positions where quantity < 0) then jsonb_build_array(jsonb_build_object('code', 'NEGATIVE_HOLDINGS', 'message', 'Sell quantities exceed imported buy quantities; history may be incomplete')) else '[]'::jsonb end)
      || (case when exists(select 1 from collisions) then jsonb_build_array(jsonb_build_object('code', 'ORDER_ID_COLLISION', 'message', 'Historical orders share an ID but have different values; review required')) else '[]'::jsonb end)
  );
$$;
revoke all on function public.stock_display_quantity(numeric, numeric, numeric, bigint, boolean) from public, anon, authenticated;
revoke all on function public.get_stock_holdings(uuid, boolean) from public, anon, authenticated;
grant execute on function public.stock_display_quantity(numeric, numeric, numeric, bigint, boolean) to service_role;
grant execute on function public.get_stock_holdings(uuid, boolean) to service_role;
commit;
