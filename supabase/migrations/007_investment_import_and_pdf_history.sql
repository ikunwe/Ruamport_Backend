-- Run after 006. Parsed previews and imported transactions contain personal
-- financial data. Raw PDFs, email bodies, passwords and Gmail tokens are NOT stored here.
begin;

create table if not exists public.investment_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  identity_key text,
  status text not null default 'PREVIEW' check (status in ('PREVIEW', 'IMPORTED')),
  preview jsonb not null check (jsonb_typeof(preview) = 'object'),
  created_at timestamptz not null default now(),
  imported_at timestamptz,
  unique (user_id, content_hash),
  unique (user_id, identity_key),
  unique (id, user_id)
);

create table if not exists public.investment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null,
  order_index integer not null check (order_index >= 0),
  order_id text not null,
  transaction_type text not null,
  asset_name text not null,
  currency text not null,
  units numeric not null,
  unit_price numeric,
  trade_date date,
  settlement_date date,
  -- All original per-order amounts/fees/currencies remain available without
  -- flattening a foreign-currency object into an incorrect THB amount.
  details jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (document_id, user_id) references public.investment_documents(id, user_id) on delete cascade,
  unique (document_id, order_index)
);

create table if not exists public.gmail_pdf_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  mailbox text not null,
  message_id text not null,
  attachment_key text not null,
  document_id uuid,
  status text not null check (status in ('READ', 'IGNORED')),
  parser_version integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (user_id, mailbox, message_id, attachment_key),
  foreign key (document_id, user_id) references public.investment_documents(id, user_id) on delete cascade,
  check ((status = 'READ' and document_id is not null) or (status = 'IGNORED' and document_id is null))
);

create index if not exists investment_documents_user_date_idx on public.investment_documents(user_id, created_at desc, id desc);
create index if not exists investment_transactions_user_date_idx on public.investment_transactions(user_id, created_at desc, id desc);
alter table public.investment_documents enable row level security;
alter table public.investment_transactions enable row level security;
alter table public.gmail_pdf_history enable row level security;
revoke all on public.investment_documents, public.investment_transactions, public.gmail_pdf_history from public, anon, authenticated;
grant select, insert, update, delete on public.investment_documents, public.investment_transactions, public.gmail_pdf_history to service_role;

-- Serialize registration per user so concurrent upload/sync of the same PDF or
-- document number cannot create two previews, even when PDF bytes differ.
create or replace function public.register_investment_preview(
  p_user_id uuid, p_content_hash text, p_identity_key text, p_preview jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  doc public.investment_documents%rowtype;
begin
  if jsonb_typeof(p_preview->'orders') is distinct from 'array' then raise exception 'Orders must be an array'; end if;
  if coalesce(p_preview->'document'->>'type', '') not in (
    'DIME_OFFSHORE_CONFIRMATION_NOTE', 'DIME_THAI_STOCK_CONFIRMATION_NOTE', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE'
  ) or coalesce(jsonb_array_length(p_preview->'orders'), 0) = 0 then
    raise exception 'Unsupported or empty confirmation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into doc from public.investment_documents
    where user_id = p_user_id and (content_hash = p_content_hash or (p_identity_key is not null and identity_key = p_identity_key))
    order by created_at, id limit 1;
  if found then return jsonb_build_object('document', to_jsonb(doc), 'alreadyRead', true); end if;
  insert into public.investment_documents(user_id, content_hash, identity_key, preview)
    values (p_user_id, p_content_hash, p_identity_key, p_preview) returning * into doc;
  return jsonb_build_object('document', to_jsonb(doc), 'alreadyRead', false);
end;
$$;

-- Import the server-stored preview, never a client-supplied array of trades.
-- Lock + all inserts + status update run in one DB transaction. A failed order
-- rolls back the entire document. Retrying an imported document is a no-op.
create or replace function public.import_investment_document(p_user_id uuid, p_document_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  doc public.investment_documents%rowtype;
  item jsonb;
  idx bigint;
  inserted_count integer := 0;
begin
  select * into doc from public.investment_documents
    where id = p_document_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('documentId', p_document_id, 'outcome', 'NOT_FOUND'); end if;
  if doc.status = 'IMPORTED' then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'ALREADY_IMPORTED', 'transactionCount', jsonb_array_length(doc.preview->'orders'));
  end if;
  if doc.identity_key is null then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'DOCUMENT_NUMBER_REQUIRED');
  end if;
  if coalesce((doc.preview->'validation'->>'isValid')::boolean, false) = false then
    return jsonb_build_object('documentId', doc.id, 'outcome', 'VALIDATION_REQUIRED');
  end if;
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
  return jsonb_build_object('documentId', doc.id, 'outcome', 'IMPORTED', 'transactionCount', inserted_count);
end;
$$;
revoke all on function public.register_investment_preview(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.import_investment_document(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_investment_preview(uuid, text, text, jsonb) to service_role;
grant execute on function public.import_investment_document(uuid, uuid) to service_role;
commit;
