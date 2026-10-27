-- Read-only analytics input; reuses 020 ownership, deduplication and bounds.
-- Does not replace the existing graph RPC or change stored PDF/trade data.
begin;
create or replace function public.get_analytics_orders(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('truncated', snapshot->'truncated', 'orders', coalesce((
    select jsonb_agg(o || jsonb_build_object('flowAmount',
      case o->>'assetType'
        when 'OFFSHORE_STOCK' then t.details->'grossAmount'->'foreign'
        when 'THAI_STOCK' then t.details->'grossAmount'
        when 'MUTUAL_FUND' then t.details->'totalAmount' end)
      order by o->>'tradeDate', o->>'id')
    from jsonb_array_elements(snapshot->'orders') o
    join public.investment_transactions t on t.id = (o->>'id')::uuid and t.user_id = p_user_id
  ), '[]'::jsonb))
  from (select public.get_portfolio_history_orders(p_user_id) as snapshot) s;
$$;
revoke all on function public.get_analytics_orders(uuid) from public, anon, authenticated;
grant execute on function public.get_analytics_orders(uuid) to service_role;
commit;
