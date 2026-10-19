-- Run after 009. Preserve every historical row for audit; flag only exact
-- repeated orders as duplicates. Different financial values are NOT merged.
begin;
create or replace function public.investment_order_identity(p_document jsonb, p_order jsonb)
returns text language sql immutable security invoker set search_path = '' as $$
  select case when nullif(btrim(p_document->>'accountNumber'), '') is null
    or nullif(btrim(p_order->>'orderId'), '') is null
    or nullif(btrim(p_order->>'tradeDate'), '') is null
    or nullif(btrim(coalesce(p_order->>'symbol', p_order->>'fundName')), '') is null
    then null else jsonb_build_array(
      p_document->>'type', btrim(p_document->>'accountNumber'),
      upper(btrim(coalesce(p_order->>'symbol', p_order->>'fundName'))),
      p_order->>'exchange', p_order->>'currency', p_order->>'transactionType',
      btrim(p_order->>'orderId'), p_order->>'tradeDate'
    )::text end;
$$;
alter table public.investment_transactions add column if not exists order_identity_key text;
alter table public.investment_transactions add column if not exists order_signature jsonb;
alter table public.investment_transactions add column if not exists is_duplicate boolean not null default false;
alter table public.investment_transactions add column if not exists duplicate_of uuid
  references public.investment_transactions(id) on delete set null;

-- transactionCode can be SEL or SELL for the same normalized SELL order.
update public.investment_transactions t set
  order_identity_key = public.investment_order_identity(d.preview->'document', t.details),
  order_signature = t.details - 'transactionCode'
from public.investment_documents d where d.id = t.document_id and d.user_id = t.user_id;
with ranked as (
  select id, first_value(id) over (
    partition by user_id, order_identity_key, order_signature order by created_at, id
  ) as canonical_id
  from public.investment_transactions where order_identity_key is not null
)
update public.investment_transactions t set is_duplicate = (t.id <> r.canonical_id),
  duplicate_of = case when t.id <> r.canonical_id then r.canonical_id else null end
from ranked r where t.id = r.id;
create unique index if not exists investment_order_unique_active_idx
  on public.investment_transactions(user_id, order_identity_key, order_signature)
  where order_identity_key is not null and not is_duplicate;
create index if not exists investment_order_lookup_idx
  on public.investment_transactions(user_id, order_identity_key) where not is_duplicate;

create or replace function public.import_investment_document(p_user_id uuid, p_document_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  doc public.investment_documents%rowtype;
  item jsonb;
  idx bigint;
  order_key text;
  signature jsonb;
  existing_id uuid;
  existing_doc uuid;
  inserted_id uuid;
  inserted_count integer := 0;
  duplicate_count integer := 0;
  unkeyed_count integer := 0;
  seen jsonb := '{}'::jsonb;
  duplicate_orders jsonb := '[]'::jsonb;
  warnings jsonb;
begin
  -- Same lock order as preview registration. Prevent concurrent cross-PDF imports
  -- of the same user's order; document row locking alone is not enough.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into doc from public.investment_documents
    where id = p_document_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('documentId', p_document_id, 'outcome', 'NOT_FOUND'); end if;
  warnings := coalesce(doc.preview->'validation'->'warnings', '[]'::jsonb);
  if doc.status = 'IMPORTED' then
    select count(*) into inserted_count from public.investment_transactions where document_id = doc.id and not is_duplicate;
    return jsonb_build_object('documentId', doc.id, 'outcome', 'ALREADY_IMPORTED',
      'transactionCount', inserted_count,
      'duplicateOrderCount', coalesce(doc.preview->'importResult'->'duplicateOrderCount', '0'::jsonb),
      'duplicateOrders', coalesce(doc.preview->'importResult'->'duplicateOrders', '[]'::jsonb),
      'warnings', coalesce(doc.preview->'importResult'->'warnings', warnings));
  end if;
  if doc.identity_key is null then return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_NUMBER_REQUIRED'); end if;
  if jsonb_typeof(doc.preview->'orders') is distinct from 'array' then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_DATA_INVALID');
  end if;
  if jsonb_array_length(doc.preview->'orders') = 0 then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_DATA_INVALID');
  end if;
  -- Preflight ALL orders before inserting: a reused ID with different values
  -- could be a correction/partial fill, not an exact repeated PDF.
  for item in select value from jsonb_array_elements(doc.preview->'orders') loop
    order_key := public.investment_order_identity(doc.preview->'document', item);
    signature := item - 'transactionCode';
    if order_key is not null then
      select t.id, t.document_id into existing_id, existing_doc
      from public.investment_transactions t where t.user_id = p_user_id
        and t.order_identity_key = order_key and not t.is_duplicate
        and t.order_signature is distinct from signature limit 1;
      if found or (seen ? order_key and seen->order_key is distinct from signature) then
        return jsonb_build_object('documentId', doc.id, 'outcome', 'ORDER_ID_CONFLICT',
          'orderId', item->>'orderId', 'existingDocumentId', existing_doc,
          'warnings', warnings || jsonb_build_array(jsonb_build_object('code', 'ORDER_ID_CONFLICT',
            'orderId', item->>'orderId', 'message', 'The same order ID has different values; no orders from this document were imported')));
      end if;
      seen := seen || jsonb_build_object(order_key, signature);
    end if;
  end loop;
  for item, idx in select value, ordinality from jsonb_array_elements(doc.preview->'orders') with ordinality loop
    order_key := public.investment_order_identity(doc.preview->'document', item);
    signature := item - 'transactionCode';
    inserted_id := null;
    insert into public.investment_transactions(user_id, document_id, order_index, order_id,
      transaction_type, asset_name, currency, units, unit_price, trade_date, settlement_date,
      details, order_identity_key, order_signature)
    values (p_user_id, doc.id, idx - 1, item->>'orderId', item->>'transactionType',
      coalesce(item->>'symbol', item->>'fundName'), item->>'currency', (item->>'units')::numeric,
      coalesce(item->>'unitPrice', item->>'pricePerShare', item->>'navPerUnit')::numeric,
      (item->>'tradeDate')::date, (item->>'settlementDate')::date, item, order_key, signature)
    on conflict (user_id, order_identity_key, order_signature)
      where order_identity_key is not null and not is_duplicate do nothing
    returning id into inserted_id;
    if inserted_id is not null then
      inserted_count := inserted_count + 1;
      if order_key is null then unkeyed_count := unkeyed_count + 1; end if;
    else
      duplicate_count := duplicate_count + 1;
      select t.id, t.document_id into existing_id, existing_doc from public.investment_transactions t
        where t.user_id = p_user_id and t.order_identity_key = order_key
          and t.order_signature = signature and not t.is_duplicate limit 1;
      duplicate_orders := duplicate_orders || jsonb_build_array(jsonb_build_object(
        'orderId', item->>'orderId', 'existingTransactionId', existing_id,
        'existingDocumentId', existing_doc,
        'existingPdfNumber', (select preview->'document'->>'documentNumber' from public.investment_documents where id = existing_doc and user_id = p_user_id)
      ));
    end if;
  end loop;
  if duplicate_count > 0 then
    warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_ORDERS_SKIPPED', 'count', duplicate_count, 'blocking', false));
  end if;
  if unkeyed_count > 0 then
    warnings := warnings || jsonb_build_array(jsonb_build_object('code', 'ORDER_IDENTITY_INCOMPLETE', 'count', unkeyed_count, 'blocking', false));
  end if;
  update public.investment_documents set status = 'IMPORTED', imported_at = now(),
    preview = jsonb_set(preview, '{importResult}', jsonb_build_object(
      'transactionCount', inserted_count, 'duplicateOrderCount', duplicate_count,
      'duplicateOrders', duplicate_orders, 'warnings', warnings
    )) where id = doc.id;
  return jsonb_build_object('documentId', doc.id, 'outcome', 'IMPORTED',
    'transactionCount', inserted_count, 'duplicateOrderCount', duplicate_count,
    'duplicateOrders', duplicate_orders, 'warnings', warnings);
end;
$$;

-- Replace 009's read-only projection to exclude flagged historical duplicates.
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
  ), collisions as (
    select order_identity_key from stock_orders where order_identity_key is not null
    group by order_identity_key having count(distinct order_signature) > 1
  )
  select jsonb_build_object(
    'scope', 'STOCK_BUY_SELL_ONLY', 'calculatedAt', now(), 'includeClosed', p_include_closed,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'exchange', exchange, 'currency', currency, 'boughtUnits', bought, 'soldUnits', sold,
      'quantity', quantity, 'transactionCount', included_count, 'excludedTransactionCount', excluded_count,
      'status', case when quantity > 0 then 'HELD' when quantity = 0 then 'CLOSED' else 'NEGATIVE' end
    ) order by asset_type, symbol, account_number, exchange, currency)
      from positions where p_include_closed or quantity <> 0), '[]'::jsonb),
    'excludedTransactions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetType', asset_type, 'accountNumber', account_number, 'symbol', symbol,
      'transactionType', transaction_type, 'count', count
    ) order by asset_type, symbol, account_number, transaction_type) from omitted), '[]'::jsonb),
    'limitations', jsonb_build_array('BUY_SELL_ONLY', 'MUTUAL_FUNDS_EXCLUDED', 'NO_COST_OR_MARKET_VALUE'),
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
revoke all on function public.investment_order_identity(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.import_investment_document(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_stock_holdings(uuid, boolean) from public, anon, authenticated;
grant execute on function public.investment_order_identity(jsonb, jsonb) to service_role;
grant execute on function public.import_investment_document(uuid, uuid) to service_role;
grant execute on function public.get_stock_holdings(uuid, boolean) to service_role;
commit;
