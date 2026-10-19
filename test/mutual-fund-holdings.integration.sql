-- Development DB only, after 012. Requires an existing test auth user.
-- Exercises the real aggregate; all synthetic records are rolled back.
begin;
do $$
declare
  uid uuid;
  account text := 'fund-test-' || gen_random_uuid()::text;
  base_order jsonb;
  orders jsonb;
  preview_json jsonb;
  registered jsonb;
  outcome jsonb;
  result jsonb;
  position jsonb;
  doc_id uuid;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  base_order := jsonb_build_object('tradeDate', '2000-02-01', 'fundName', 'KKP US500-UH-E',
    'currency', 'THB', 'units', 10, 'navPerUnit', 10, 'totalAmount', 100, 'feeIncludeVat', 0);
  orders := jsonb_build_array(
    base_order || jsonb_build_object('orderId', 'TESTSUB', 'transactionType', 'SUBSCRIPTION', 'units', 10),
    base_order || jsonb_build_object('orderId', 'TESTSWI', 'transactionType', 'SWITCH_IN', 'units', 3),
    base_order || jsonb_build_object('orderId', 'TESTRED', 'transactionType', 'REDEMPTION', 'units', 2),
    base_order || jsonb_build_object('orderId', 'TESTSWO', 'transactionType', 'SWITCH_OUT', 'units', 1)
  );
  preview_json := jsonb_build_object('document', jsonb_build_object('type', 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE',
    'accountNumber', account, 'documentNumber', 'fund-test-1'), 'orders', orders,
    'validation', jsonb_build_object('isValid', true, 'warnings', '[]'::jsonb));
  registered := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':1', preview_json);
  doc_id := (registered->'document'->>'id')::uuid;
  outcome := public.import_investment_document(uid, doc_id);
  if (outcome->>'transactionCount')::int <> 4 then raise exception 'Fund import failed: %', outcome; end if;
  result := public.get_stock_holdings(uid);
  if result->>'scope' <> 'STOCKS_AND_MUTUAL_FUNDS' then raise exception 'Wrong aggregate scope'; end if;
  select item into position from jsonb_array_elements(result->'items') item
    where item->>'accountNumber' = account and item->>'symbol' = 'KKP US500-UH-E';
  if position is null or (position->>'quantity')::numeric is distinct from 10::numeric
    or (position->>'boughtUnits')::numeric is distinct from 10::numeric
    or (position->>'soldUnits')::numeric is distinct from 2::numeric
    or (position->>'switchInUnits')::numeric is distinct from 3::numeric
    or (position->>'switchOutUnits')::numeric is distinct from 1::numeric
    or position->>'assetType' <> 'MUTUAL_FUND' then raise exception 'Wrong fund aggregation: %', position; end if;

  -- New PDF for the same orders must not double-count any fund units.
  registered := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':2', preview_json);
  outcome := public.import_investment_document(uid, (registered->'document'->>'id')::uuid);
  if (outcome->>'transactionCount')::int <> 0 or (outcome->>'duplicateOrderCount')::int <> 4 then raise exception 'Fund dedup failed: %', outcome; end if;

  -- Do not apply the stock closure tolerance to a mutual fund residual.
  orders := jsonb_build_array(
    base_order || jsonb_build_object('fundName', 'TINY-FUND', 'orderId', 'TINYSUB', 'transactionType', 'SUBSCRIPTION', 'units', 1),
    base_order || jsonb_build_object('fundName', 'TINY-FUND', 'orderId', 'TINYRED', 'transactionType', 'REDEMPTION', 'units', 0.9999998)
  );
  preview_json := jsonb_set(preview_json, '{orders}', orders);
  registered := public.register_investment_preview(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), account||':3', preview_json);
  perform public.import_investment_document(uid, (registered->'document'->>'id')::uuid);
  select item into position from jsonb_array_elements(public.get_stock_holdings(uid)->'items') item
    where item->>'accountNumber' = account and item->>'symbol' = 'TINY-FUND';
  if position is null or (position->>'quantity')::numeric is distinct from 0.0000002::numeric
    or (position->>'roundingAdjusted')::boolean is distinct from false
    or position->>'roundingTolerance' is not null then raise exception 'Stock tolerance incorrectly applied to fund: %', position; end if;
  raise notice 'Fund holdings integration checks passed; rolling back synthetic records';
end;
$$;
rollback;
