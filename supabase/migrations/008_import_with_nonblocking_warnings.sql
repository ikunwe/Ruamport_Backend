-- Apply AFTER 007. Validation mismatches are advisory once the user explicitly
-- confirms /trades/import. Keep ownership, identity and transaction integrity.
begin;
create or replace function public.import_investment_document(p_user_id uuid, p_document_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  doc public.investment_documents%rowtype;
  item jsonb;
  idx bigint;
  inserted_count integer := 0;
  warnings jsonb;
begin
  select * into doc from public.investment_documents
    where id = p_document_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('documentId', p_document_id, 'outcome', 'NOT_FOUND'); end if;
  warnings := coalesce(doc.preview->'validation'->'warnings', '[]'::jsonb);
  if doc.status = 'IMPORTED' then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'ALREADY_IMPORTED',
      'transactionCount', jsonb_array_length(doc.preview->'orders'), 'warnings', warnings);
  end if;
  if doc.identity_key is null then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_NUMBER_REQUIRED');
  end if;
  if jsonb_typeof(doc.preview->'orders') is distinct from 'array' then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_DATA_INVALID');
  end if;
  if jsonb_array_length(doc.preview->'orders') = 0 then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_DATA_INVALID');
  end if;
  -- Do not block on validation.isValid: preserve the original warnings for audit.
  for item, idx in select value, ordinality from jsonb_array_elements(doc.preview->'orders') with ordinality loop
    insert into public.investment_transactions(user_id, document_id, order_index, order_id,
      transaction_type, asset_name, currency, units, unit_price, trade_date, settlement_date, details)
    values (p_user_id, doc.id, idx - 1, item->>'orderId', item->>'transactionType',
      coalesce(item->>'symbol', item->>'fundName'), item->>'currency', (item->>'units')::numeric,
      coalesce(item->>'unitPrice', item->>'pricePerShare', item->>'navPerUnit')::numeric,
      (item->>'tradeDate')::date, (item->>'settlementDate')::date, item);
    inserted_count := inserted_count + 1;
  end loop;
  update public.investment_documents set status = 'IMPORTED', imported_at = now() where id = doc.id;
  return jsonb_build_object('documentId', doc.id, 'outcome', 'IMPORTED',
    'transactionCount', inserted_count, 'warnings', warnings);
end;
$$;
revoke all on function public.import_investment_document(uuid, uuid) from public, anon, authenticated;
grant execute on function public.import_investment_document(uuid, uuid) to service_role;
commit;
