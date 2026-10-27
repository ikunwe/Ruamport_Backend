-- Read-only history input. Run after 019; no tables or stored trades changed.
begin;
create or replace function public.get_portfolio_history_orders(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with imported as (
    select t.id, t.transaction_type, t.units, t.currency, t.trade_date, t.asset_name,
      t.order_identity_key, t.order_signature,
      d.preview->'document'->>'accountNumber' as account_number,
      case d.preview->'document'->>'type'
        when 'DIME_OFFSHORE_CONFIRMATION_NOTE' then 'OFFSHORE_STOCK'
        when 'DIME_THAI_STOCK_CONFIRMATION_NOTE' then 'THAI_STOCK'
        when 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE' then 'MUTUAL_FUND' end as asset_type,
      case when d.preview->'document'->>'type' <> 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE'
        then nullif(t.details->>'exchange', '') end as exchange
    from public.investment_transactions t
    join public.investment_documents d on d.id = t.document_id and d.user_id = t.user_id
    where t.user_id = p_user_id and d.status = 'IMPORTED' and not t.is_duplicate
      and d.preview->'document'->>'type' in ('DIME_OFFSHORE_CONFIRMATION_NOTE',
        'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE')
  ), collisions as (
    select order_identity_key from imported where order_identity_key is not null
    group by order_identity_key having count(distinct order_signature) > 1
  ), bounded as (
    select i.*, c.order_identity_key is not null as collision from imported i
    left join collisions c on c.order_identity_key = i.order_identity_key
    order by i.trade_date nulls first, i.id limit 20001
  )
  select jsonb_build_object('truncated', count(*) > 20000, 'orders', coalesce(jsonb_agg(
    jsonb_build_object('id', id, 'assetType', asset_type, 'accountNumber', account_number,
      'symbol', asset_name, 'exchange', exchange, 'currency', currency,
      'transactionType', transaction_type, 'units', units, 'tradeDate', trade_date,
      'collision', collision) order by trade_date nulls first, id), '[]'::jsonb)) from bounded;
$$;
revoke all on function public.get_portfolio_history_orders(uuid) from public, anon, authenticated;
grant execute on function public.get_portfolio_history_orders(uuid) to service_role;
commit;
