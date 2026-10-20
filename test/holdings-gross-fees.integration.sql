-- Development PostgreSQL/Supabase only, after 014. All changes roll back.
-- First block is pure numeric aggregation; second needs an existing test auth user.
begin;
do $$
declare
  test_case record;
  actual jsonb;
  row_value jsonb;
begin
  if public.investment_amount_summary('[]') <> '[]'::jsonb then raise exception 'Empty summary changed'; end if;
  for test_case in select * from (values
    ('Offshore gross and fees are independent from totals and discounts',
      '[{"movement":"BUY","assetType":"OFFSHORE_STOCK","currency":"USD","totalAmount":{"foreign":30,"thb":1050},"grossAmount":{"foreign":29.95,"thb":1048.25},"feeIncludeVat":{"foreign":0.05,"thb":1.75},"discount":999},{"movement":"SELL","assetType":"OFFSHORE_STOCK","currency":"USD","totalAmount":{"foreign":40,"thb":1400},"grossAmount":{"foreign":40.1,"thb":1403.5},"feeIncludeVat":{"foreign":0.1,"thb":3.5}}]'::jsonb,
      '[{"currency":"USD","totalBuy":30,"totalSell":40,"totalBuyGross":29.95,"totalSellGross":40.1,"totalBuyFeeIncludeVat":0.05,"totalSellFeeIncludeVat":0.1,"totalFeeIncludeVat":0.15,"grossIsComplete":true,"feeIsComplete":true},{"currency":"THB","totalBuyGross":1048.25,"totalSellGross":1403.5,"totalFeeIncludeVat":5.25}]'::jsonb),
    ('Thai fees add VAT once and have no fabricated USD',
      '[{"movement":"BUY","assetType":"THAI_STOCK","currency":"THB","totalAmount":300,"grossAmount":299.68,"feeExcludeVat":0.3,"vat":0.02},{"movement":"SELL","assetType":"THAI_STOCK","currency":"THB","totalAmount":200,"grossAmount":200.22,"feeExcludeVat":0.2,"vat":0.02}]'::jsonb,
      '[{"currency":"THB","totalBuyGross":299.68,"totalSellGross":200.22,"totalBuyFeeIncludeVat":0.32,"totalSellFeeIncludeVat":0.22,"totalFeeIncludeVat":0.54,"grossIsComplete":true,"feeIsComplete":true}]'::jsonb),
    ('Zero fee is valid; absent gross is not derived from the payment',
      '[{"movement":"BUY","assetType":"OFFSHORE_STOCK","currency":"USD","totalAmount":{"foreign":30,"thb":1050},"grossAmount":{"foreign":30},"feeIncludeVat":{"foreign":0,"thb":0}}]'::jsonb,
      '[{"currency":"USD","totalBuyGross":30,"totalFeeIncludeVat":0,"feeIsComplete":true},{"currency":"THB","totalBuyGross":null,"grossIsComplete":false,"missingGrossAmountCount":1,"totalFeeIncludeVat":0,"feeIsComplete":true,"isComplete":true}]'::jsonb),
    ('Malformed fee does not invalidate separately available gross or total',
      '[{"movement":"BUY","assetType":"OFFSHORE_STOCK","currency":"USD","totalAmount":{"foreign":30,"thb":1050},"grossAmount":{"foreign":29.95,"thb":1048.25},"feeIncludeVat":{"foreign":"bad","thb":1.75}}]'::jsonb,
      '[{"currency":"USD","totalBuy":30,"totalBuyGross":29.95,"totalBuyFeeIncludeVat":null,"totalSellFeeIncludeVat":0,"totalFeeIncludeVat":null,"feeIsComplete":false,"missingFeeAmountCount":1,"grossIsComplete":true,"isComplete":true},{"currency":"THB","feeIsComplete":true}]'::jsonb),
    ('Missing Thai VAT cannot be treated as zero',
      '[{"movement":"BUY","assetType":"THAI_STOCK","currency":"THB","totalAmount":10,"grossAmount":9,"feeExcludeVat":1}]'::jsonb,
      '[{"currency":"THB","totalBuyGross":9,"totalFeeIncludeVat":null,"feeIsComplete":false,"missingFeeAmountCount":1}]'::jsonb),
    ('Fund gross remains unknown and switches have separate fee buckets',
      '[{"movement":"BUY","assetType":"MUTUAL_FUND","currency":"THB","totalAmount":100,"feeIncludeVat":1},{"movement":"SELL","assetType":"MUTUAL_FUND","currency":"THB","totalAmount":50,"feeIncludeVat":0.5},{"movement":"SWITCH_IN","assetType":"MUTUAL_FUND","currency":"THB","totalAmount":20,"feeIncludeVat":0.2},{"movement":"SWITCH_OUT","assetType":"MUTUAL_FUND","currency":"THB","totalAmount":10,"feeIncludeVat":0.1}]'::jsonb,
      '[{"currency":"THB","totalBuyGross":null,"totalSellGross":null,"grossIsComplete":false,"missingGrossAmountCount":4,"totalBuyFeeIncludeVat":1,"totalSellFeeIncludeVat":0.5,"totalSwitchInFeeIncludeVat":0.2,"totalSwitchOutFeeIncludeVat":0.1,"totalFeeIncludeVat":1.8,"feeIsComplete":true}]'::jsonb),
    ('Exact numeric decimals and unsupported movements',
      '[{"movement":"BUY","assetType":"THAI_STOCK","currency":"THB","totalAmount":1,"grossAmount":0.1,"feeExcludeVat":0.1,"vat":0},{"movement":"BUY","assetType":"THAI_STOCK","currency":"THB","totalAmount":1,"grossAmount":0.2,"feeExcludeVat":0.2,"vat":0},{"movement":null,"assetType":"THAI_STOCK","currency":"THB","totalAmount":999,"grossAmount":999,"feeExcludeVat":999,"vat":999}]'::jsonb,
      '[{"currency":"THB","totalBuyGross":0.3,"totalFeeIncludeVat":0.3,"orderCount":2}]'::jsonb)
  ) as cases(label, orders, expected) loop
    actual := public.investment_amount_summary(test_case.orders);
    if jsonb_array_length(actual) <> jsonb_array_length(test_case.expected) then
      raise exception '%: wrong currencies: %', test_case.label, actual;
    end if;
    for row_value in select value from jsonb_array_elements(test_case.expected) loop
      if not exists(select 1 from jsonb_array_elements(actual) value where value @> row_value)
        then raise exception '%: expected %, actual %', test_case.label, row_value, actual; end if;
    end loop;
  end loop;
end;
$$;

do $$
declare
  uid uuid;
  account text := 'gross-fee-test-' || gen_random_uuid()::text;
  doc uuid;
  pending uuid;
  item jsonb;
  result jsonb;
  position jsonb;
  amount jsonb;
  idx integer := 0;
begin
  select id into uid from auth.users limit 1;
  if uid is null then raise exception 'Create a development test user first'; end if;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account),
        'summary', jsonb_build_object('discount', 999))) returning id into doc;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'PREVIEW',
      jsonb_build_object('document', jsonb_build_object('type', 'DIME_OFFSHORE_CONFIRMATION_NOTE', 'accountNumber', account))) returning id into pending;
  for item in select value from jsonb_array_elements('[
    {"type":"BUY","units":1,"gross":29.95,"fee":0.05,"total":30},
    {"type":"SELL","units":1,"gross":40.1,"fee":0.1,"total":40},
    {"type":"BUY","units":1,"gross":29.95,"fee":0.05,"total":30,"duplicate":true},
    {"type":"REWARD","units":1,"gross":999,"fee":999,"total":999},
    {"type":"BUY","units":1,"gross":999,"fee":999,"total":999,"pending":true}
  ]'::jsonb) loop
    insert into public.investment_transactions(user_id, document_id, order_index, order_id,
      transaction_type, asset_name, currency, units, details, is_duplicate)
    values(uid, case when item->>'pending' = 'true' then pending else doc end, idx, 'TEST-'||idx,
      item->>'type', account, 'USD', (item->>'units')::numeric,
      jsonb_build_object('grossAmount', jsonb_build_object('foreign', item->'gross', 'thb', (item->>'gross')::numeric * 35),
        'feeIncludeVat', jsonb_build_object('foreign', item->'fee', 'thb', (item->>'fee')::numeric * 35),
        'totalAmount', jsonb_build_object('foreign', item->'total', 'thb', (item->>'total')::numeric * 35)),
      coalesce((item->>'duplicate')::boolean, false));
    idx := idx + 1;
  end loop;
  result := public.get_stock_holdings(uid, true);
  select value into position from jsonb_array_elements(result->'items') where value->>'accountNumber' = account;
  select value into amount from jsonb_array_elements(position->'amounts') where value->>'currency' = 'USD';
  if amount is null or not (amount @> '{"totalBuy":30,"totalSell":40,"totalBuyGross":29.95,"totalSellGross":40.1,"totalBuyFeeIncludeVat":0.05,"totalSellFeeIncludeVat":0.1,"totalFeeIncludeVat":0.15,"orderCount":2}'::jsonb)
    then raise exception 'RPC lost fields, double counted or allocated discounts: %', position; end if;
  select value into amount from jsonb_array_elements(position->'amounts') where value->>'currency' = 'THB';
  if amount is null or not (amount @> '{"totalBuyGross":1048.25,"totalSellGross":1403.5,"totalFeeIncludeVat":5.25}'::jsonb)
    then raise exception 'Wrong historical THB: %', amount; end if;
  if (result->>'documentDiscountsApplied')::boolean is distinct from false then raise exception 'Discount metadata missing'; end if;
  if result->'moneyTotals' is distinct from public.get_stock_holdings(uid, false)->'moneyTotals'
    or result->'stockMoneyTotals' is distinct from public.get_stock_holdings(uid, false)->'stockMoneyTotals'
    then raise exception 'Closed filter changed totals'; end if;
  if public.get_stock_holdings(gen_random_uuid(), true)->'stockMoneyTotals' <> '[]'::jsonb
    then raise exception 'User isolation failed'; end if;
  raise notice 'Gross and VAT-inclusive fee checks passed; rolling back fixtures';
end;
$$;
rollback;
