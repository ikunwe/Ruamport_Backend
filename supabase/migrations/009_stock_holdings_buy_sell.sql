-- Read-only projection of imported stock orders. No holdings are written and
-- no prices/cost basis are inferred. PostgreSQL numeric keeps share sums exact.
begin;
create or replace function public.get_stock_holdings(p_user_id uuid, p_include_closed boolean default false)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with stock_orders as (
    select t.id, t.transaction_type, t.units, t.currency, t.asset_name as symbol,
      d.preview->'document'->>'accountNumber' as account_number,
      case d.preview->'document'->>'type'
        when 'DIME_OFFSHORE_CONFIRMATION_NOTE' then 'OFFSHORE_STOCK'
        when 'DIME_THAI_STOCK_CONFIRMATION_NOTE' then 'THAI_STOCK'
      end as asset_type,
      nullif(t.details->>'exchange', '') as exchange
    from public.investment_transactions t
    join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
    where t.user_id = p_user_id and d.status = 'IMPORTED'
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE')
  ), grouped as (
    select asset_type, account_number, symbol, exchange, currency,
      coalesce(sum(units) filter (where transaction_type = 'BUY'), 0) as bought,
      coalesce(sum(units) filter (where transaction_type = 'SELL'), 0) as sold,
      count(*) filter (where transaction_type in ('BUY', 'SELL')) as included_count,
      count(*) filter (where transaction_type not in ('BUY', 'SELL')) as excluded_count
    from stock_orders group by asset_type, account_number, symbol, exchange, currency
  ), positions as (
    select *, bought - sold as quantity from grouped where included_count > 0
  ), omitted as (
    select asset_type, account_number, symbol, transaction_type, count(*) as count
    from stock_orders where transaction_type not in ('BUY', 'SELL')
    group by asset_type, account_number, symbol, transaction_type
  )
  select jsonb_build_object(
    'scope', 'STOCK_BUY_SELL_ONLY',
    'calculatedAt', now(),
    'includeClosed', p_include_closed,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'exchange', exchange, 'currency', currency, 'boughtUnits', bought,
      'soldUnits', sold, 'quantity', quantity, 'transactionCount', included_count,
      'excludedTransactionCount', excluded_count,
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'excludedTransactions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'transactionType', transaction_type, 'count', count
    ) order by asset_type, symbol, account_number, transaction_type) from omitted), '[]'::jsonb),
    'limitations', jsonb_build_array('BUY_SELL_ONLY', 'MUTUAL_FUNDS_EXCLUDED', 'NO_COST_OR_MARKET_VALUE'),
    'warnings',
      (case when exists(select 1 from omitted) then jsonb_build_array(jsonb_build_object(
        'code', 'SPECIAL_TRANSACTIONS_EXCLUDED', 'message', 'Stock rewards and option exercises are not included in quantities yet'
      )) else '[]'::jsonb end)
      || (case when exists(select 1 from positions where quantity < 0) then jsonb_build_array(jsonb_build_object(
        'code', 'NEGATIVE_HOLDINGS', 'message', 'Sell quantities exceed imported buy quantities; history may be incomplete'
      )) else '[]'::jsonb end)
  );
$$;
revoke all on function public.get_stock_holdings(uuid, boolean) from public, anon, authenticated;
grant execute on function public.get_stock_holdings(uuid, boolean) to service_role;
commit;
