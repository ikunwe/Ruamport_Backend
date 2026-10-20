-- Optional integration test: run AFTER 010 on a DEVELOPMENT Supabase database.
-- Requires an existing auth user. All synthetic rows are rolled back.
begin;
do $$
declare
  uid uuid;
  account text := 'dedup-test-' || gen_random_uuid()::text;
  doc_json jsonb;
  buy_order jsonb;
  sell_order jsonb;
  result jsonb;
  preview_json jsonb;
  first_doc uuid;
  next_doc uuid;
  before_count integer;
  held numeric;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a test auth user first'; end if;
  buy_order := jsonb_build_object('orderId', '000001', 'tradeDate', '2000-01-01',
    'settlementDate', '2000-01-03', 'transactionType', 'BUY', 'transactionCode', 'BUY',
    'symbol', 'AMD', 'exchange', 'XNAS', 'currency', 'USD', 'units', 2.5,
    'unitPrice', 10, 'totalAmount', jsonb_build_object('foreign', 25, 'thb', 800));
  doc_json := jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE',
    'accountNumber', account, 'documentNumber', 'test-1', 'taxInvoiceNumber', 'DIMEOS-test-1');
  preview_json := jsonb_build_object('document', doc_json, 'orders', jsonb_build_array(buy_order),
    'validation', jsonb_build_object('isValid', false, 'warnings', jsonb_build_array(jsonb_build_object('code', 'TOTAL_BUY_MISMATCH'))));
  result := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':1', preview_json);
  first_doc := (result->'document'->>'id')::uuid;
  result := public.import_investment_document(uid, first_doc);
  if result->>'outcome' <> 'IMPORTED' or (result->>'transactionCount')::int <> 1 then raise exception 'First import failed: %', result; end if;

  -- Different PDF/document number, same order: no second trade.
  preview_json := jsonb_set(preview_json, '{document,documentNumber}', '"test-2"');
  result := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':2', preview_json);
  next_doc := (result->'document'->>'id')::uuid;
  result := public.import_investment_document(uid, next_doc);
  if (result->>'transactionCount')::int <> 0 or (result->>'duplicateOrderCount')::int <> 1 then raise exception 'Duplicate order imported: %', result; end if;

  -- Mixed document: duplicate BUY skipped, new SELL included.
  sell_order := buy_order || jsonb_build_object('orderId', '000002', 'transactionType', 'SELL', 'transactionCode', 'SEL', 'units', 0.5);
  preview_json := jsonb_set(preview_json, '{orders}', jsonb_build_array(buy_order, sell_order));
  result := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':3', preview_json);
  next_doc := (result->'document'->>'id')::uuid;
  result := public.import_investment_document(uid, next_doc);
  if (result->>'transactionCount')::int <> 1 or (result->>'duplicateOrderCount')::int <> 1 then raise exception 'Mixed import failed: %', result; end if;
  select (item->>'quantity')::numeric into held from jsonb_array_elements(public.get_stock_holdings(uid)->'items') item
    where item->>'accountNumber' = account and item->>'symbol' = 'AMD';
  if held is distinct from 2.0 then raise exception 'Holdings should be 2.0, got %', held; end if;

  -- Conflict after a valid new order must not leave a partial import.
  select count(*) into before_count from public.investment_transactions where user_id = uid;
  preview_json := jsonb_set(preview_json, '{orders}', jsonb_build_array(
    buy_order || jsonb_build_object('orderId', '000003'), buy_order || jsonb_build_object('units', 3)));
  result := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':4', preview_json);
  next_doc := (result->'document'->>'id')::uuid;
  result := public.import_investment_document(uid, next_doc);
  if result->>'outcome' <> 'ORDER_ID_CONFLICT' then raise exception 'Expected conflict: %', result; end if;
  if (select count(*) from public.investment_transactions where user_id = uid) <> before_count then raise exception 'Conflict caused partial import'; end if;
  if (select status from public.investment_documents where id = next_doc) <> 'PREVIEW' then raise exception 'Conflict document should remain PREVIEW'; end if;

  -- Same short order ID on another date is a different order.
  preview_json := jsonb_set(preview_json, '{orders}', jsonb_build_array(buy_order || jsonb_build_object('tradeDate', '2000-01-02')));
  result := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':5', preview_json);
  next_doc := (result->'document'->>'id')::uuid;
  result := public.import_investment_document(uid, next_doc);
  if (result->>'transactionCount')::int <> 1 then raise exception 'Reused ID on new date incorrectly skipped'; end if;
  result := public.import_investment_document(uid, first_doc);
  if result->>'outcome' <> 'ALREADY_IMPORTED' then raise exception 'Retry was not idempotent'; end if;
  raise notice 'Order deduplication integration checks passed. Rolling back test rows.';
end;
$$;
rollback;
