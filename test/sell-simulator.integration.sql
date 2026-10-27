begin;
do $$
declare
  uid uuid; other_uid uuid := gen_random_uuid(); offshore uuid; thai_doc uuid; fund_doc uuid;
  r jsonb; full_sale jsonb; request jsonb; previous jsonb; before_state jsonb; after_state jsonb; rev text;
begin
  select id into uid from auth.users limit 1;
  insert into auth.users values (other_uid);
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      '{"document":{"type":"DIME_OFFSHORE_CONFIRMATION_NOTE","accountNumber":"SIM-A"}}') returning id into offshore;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      '{"document":{"type":"DIME_THAI_STOCK_CONFIRMATION_NOTE","accountNumber":"SIM-A"}}') returning id into thai_doc;
  insert into public.investment_documents(user_id, content_hash, status, preview)
    values(uid, md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text), 'IMPORTED',
      '{"document":{"type":"DIME_MUTUAL_FUND_CONFIRMATION_NOTE","accountNumber":"SIM-A"}}') returning id into fund_doc;
  insert into public.investment_transactions(user_id, document_id, order_index, order_id, transaction_type,
    asset_name, currency, units, trade_date, details) values
    (uid, offshore, 0, 'SIM-OS-1', 'BUY', 'SIMOS', 'USD', 10, '2026-10-01', '{"exchange":"XNAS","grossAmount":{"foreign":100,"thb":3100},"feeIncludeVat":{"foreign":99}}'),
    (uid, offshore, 1, 'SIM-OS-2', 'BUY', 'SIMOS', 'USD', 10, '2026-10-01', '{"exchange":"XNAS","grossAmount":{"foreign":200,"thb":6400}}'),
    (uid, offshore, 2, 'SIM-OS-3', 'BUY', 'SIMOS', 'USD', 10, '2026-10-02', '{"exchange":"XNAS","grossAmount":{"foreign":300,"thb":9900}}'),
    (uid, offshore, 3, 'SIM-OS-4', 'SELL', 'SIMOS', 'USD', 5, '2026-10-03', '{"exchange":"XNAS","grossAmount":{"foreign":250,"thb":8500}}'),
    (uid, thai_doc, 0, 'SIM-TH-1', 'BUY', 'SIMTH', 'THB', 10, '2026-10-01', '{"grossAmount":100,"feeIncludeVat":99}'),
    (uid, thai_doc, 1, 'SIM-TH-2', 'BUY', 'SIMTH', 'THB', 10, '2026-10-02', '{"grossAmount":200}'),
    (uid, thai_doc, 2, 'SIM-TH-3', 'SELL', 'SIMTH', 'THB', 2, '2026-10-03', '{"grossAmount":60}'),
    (uid, fund_doc, 0, 'SIM-MF-1', 'SUBSCRIPTION', 'SIMFUND', 'THB', 10, '2026-10-01', '{"totalAmount":100,"feeIncludeVat":99}'),
    (uid, fund_doc, 1, 'SIM-MF-2', 'SUBSCRIPTION', 'SIMFUND', 'THB', 10, '2026-10-02', '{"totalAmount":200}'),
    (uid, fund_doc, 2, 'SIM-MF-3', 'REDEMPTION', 'SIMFUND', 'THB', 2, '2026-10-03', '{"totalAmount":60}');
  select jsonb_build_object('transactions', (select jsonb_agg(to_jsonb(t) order by id) from public.investment_transactions t where user_id = uid),
    'documents', (select jsonb_agg(to_jsonb(d) order by id) from public.investment_documents d where user_id = uid),
    'holdings', public.get_stock_holdings(uid, true)) into before_state;
  request := '{"assetType":"OFFSHORE_STOCK","accountNumber":"SIM-A","symbol":"SIMOS","exchange":"XNAS","currency":"USD","action":"SELL","quantity":10,"price":40,"tradeDate":"2026-10-27"}';
  r := public.simulate_investment_sale(uid, request);
  if not coalesce(r @> '{"status":"CALCULATED","method":"COMPRESSED_FIFO","soldCost":150,"proceeds":400,"realizedPnl":250,"persisted":false,
    "before":{"quantity":25,"remainingCost":525,"averageCostPerUnit":21},"after":{"quantity":15,"remainingCost":375,"averageCostPerUnit":25}}'::jsonb, false)
    then raise exception 'Compressed FIFO partial sale incorrect: %', r; end if;
  if (r->>'realizedPnlPercent')::numeric is distinct from 166.666667 then raise exception 'PnL percent wrong'; end if;
  rev := r->'snapshot'->>'revision';
  previous := public.simulate_investment_sale(uid, request || jsonb_build_object('price', 100, 'expectedSnapshotRevision', rev));
  if previous->'snapshot'->>'revision' is distinct from rev then raise exception 'Simulation changed snapshot'; end if;
  full_sale := public.simulate_investment_sale(uid, request || '{"quantity":25}');
  if not coalesce(full_sale @> '{"status":"CALCULATED","soldCost":525,"proceeds":1000,"realizedPnl":475,"after":{"quantity":0,"remainingCost":0,"averageCostPerUnit":null}}', false)
    then raise exception 'Full sale incorrect: %', full_sale; end if;
  r := public.simulate_investment_sale(uid, request || '{"quantity":26}');
  if r->>'errorCode' is distinct from 'SIMULATION_QUANTITY_EXCEEDED' then raise exception 'Oversell accepted'; end if;
  r := public.simulate_investment_sale(uid, request || '{"tradeDate":"2026-10-01"}');
  if r->>'errorCode' is distinct from 'SIMULATION_DATE_BEFORE_SNAPSHOT' then raise exception 'Retroactive simulation accepted'; end if;
  r := public.simulate_investment_sale(uid, request || '{"accountNumber":"OTHER"}');
  if r->>'errorCode' is distinct from 'SIMULATION_POSITION_NOT_FOUND' then raise exception 'Accounts merged'; end if;
  r := public.simulate_investment_sale(uid, request || '{"exchange":"XNYS"}');
  if r->>'errorCode' is distinct from 'SIMULATION_POSITION_NOT_FOUND' then raise exception 'PDF exchanges merged'; end if;
  r := public.simulate_investment_sale(other_uid, request);
  if r->>'errorCode' is distinct from 'SIMULATION_POSITION_NOT_FOUND' then raise exception 'Owner leaked'; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"THAI_STOCK","accountNumber":"SIM-A","symbol":"SIMTH","exchange":null,"currency":"THB","action":"SELL","quantity":8,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"CALCULATED","method":"FIFO","soldCost":80,"proceeds":320,"realizedPnl":240,"before":{"remainingCost":280,"quantity":18},"after":{"quantity":10,"remainingCost":200,"averageCostPerUnit":20}}', false)
    then raise exception 'Thai FIFO partial sale incorrect: %', r; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"MUTUAL_FUND","accountNumber":"SIM-A","symbol":"SIMFUND","exchange":null,"currency":"THB","action":"SELL","quantity":8,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"CALCULATED","method":"MOVING_WEIGHTED_AVERAGE","soldCost":120,"proceeds":320,"realizedPnl":200,"before":{"remainingCost":270,"quantity":18},"after":{"quantity":10,"remainingCost":150,"averageCostPerUnit":15}}', false)
    then raise exception 'Fund Average Cost incorrect: %', r; end if;
  select jsonb_build_object('transactions', (select jsonb_agg(to_jsonb(t) order by id) from public.investment_transactions t where user_id = uid),
    'documents', (select jsonb_agg(to_jsonb(d) order by id) from public.investment_documents d where user_id = uid),
    'holdings', public.get_stock_holdings(uid, true)) into after_state;
  if before_state is distinct from after_state then raise exception 'Simulation mutated portfolio/documents/trades'; end if;
  -- Changes anywhere in effective imported portfolio invalidate a previous revision.
  update public.investment_transactions set details = details || '{"grossAmount":201}'
    where user_id = uid and document_id = thai_doc and order_index = 1;
  r := public.simulate_investment_sale(uid, request || jsonb_build_object('expectedSnapshotRevision', rev));
  if r->>'errorCode' is distinct from 'SIMULATION_SNAPSHOT_CHANGED' then raise exception 'Stale snapshot accepted'; end if;
  -- Different-price same-day Thai lots cannot be cut using an invented order.
  insert into public.investment_transactions(user_id, document_id, order_index, order_id, transaction_type,
    asset_name, currency, units, trade_date, details) values
    (uid, thai_doc, 3, 'AMB1', 'BUY', 'SIMAMB', 'THB', 10, '2026-10-01', '{"grossAmount":100}'),
    (uid, thai_doc, 4, 'AMB2', 'BUY', 'SIMAMB', 'THB', 10, '2026-10-01', '{"grossAmount":200}'),
    (uid, thai_doc, 5, 'TODAY1', 'BUY', 'SIMTODAY', 'THB', 10, '2026-10-27', '{"grossAmount":100}'),
    (uid, fund_doc, 3, 'MISSING1', 'SUBSCRIPTION', 'SIMMISSING', 'THB', 10, '2026-10-01', '{}');
  r := public.simulate_investment_sale(uid, '{"assetType":"THAI_STOCK","accountNumber":"SIM-A","symbol":"SIMAMB","exchange":null,"currency":"THB","action":"SELL","quantity":5,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"INCOMPLETE","soldCost":null,"realizedPnl":null,"proceeds":200,"issues":["INTRADAY_BUY_ORDER_AMBIGUOUS"]}', false)
    then raise exception 'Ambiguous FIFO guessed: %', r; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"THAI_STOCK","accountNumber":"SIM-A","symbol":"SIMTODAY","exchange":null,"currency":"THB","action":"SELL","quantity":5,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"INCOMPLETE","soldCost":null,"issues":["INTRADAY_ORDER_AMBIGUOUS"]}', false)
    then raise exception 'Same-day order invented: %', r; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"MUTUAL_FUND","accountNumber":"SIM-A","symbol":"SIMMISSING","exchange":null,"currency":"THB","action":"SELL","quantity":5,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"INCOMPLETE","soldCost":null,"realizedPnl":null,"proceeds":200}', false)
    then raise exception 'Missing buy amount became zero: %', r; end if;
  -- Preserve the existing stock dust closure, but never apply it to fund units.
  insert into public.investment_transactions(user_id, document_id, order_index, order_id, transaction_type,
    asset_name, currency, units, trade_date, details) values
    (uid, offshore, 4, 'DUST1', 'BUY', 'SIMDUST', 'USD', 10, '2026-10-01', '{"exchange":"XNAS","grossAmount":{"foreign":100,"thb":3100}}'),
    (uid, fund_doc, 4, 'FUNDDUST1', 'SUBSCRIPTION', 'SIMFUNDDUST', 'THB', 10, '2026-10-01', '{"totalAmount":100}'),
    (uid, thai_doc, 6, 'CLOSED1', 'BUY', 'SIMCLOSED', 'THB', 10, '2026-10-01', '{"grossAmount":100}'),
    (uid, thai_doc, 7, 'CLOSED2', 'SELL', 'SIMCLOSED', 'THB', 10, '2026-10-02', '{"grossAmount":200}');
  r := public.simulate_investment_sale(uid, request || '{"symbol":"SIMDUST","quantity":9.9999998}');
  if not coalesce(r @> '{"status":"CALCULATED","soldCost":100,"after":{"quantity":0,"rawQuantity":0.0000002,"remainingCost":0,"rawRemainingCost":0.000002,"roundingAdjusted":true},"issues":["ROUNDING_CLOSURE_ESTIMATE"]}', false)
    then raise exception 'Stock dust was lost or not closed: %', r; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"MUTUAL_FUND","accountNumber":"SIM-A","symbol":"SIMFUNDDUST","exchange":null,"currency":"THB","action":"SELL","quantity":9.9999998,"price":40,"tradeDate":"2026-10-27"}');
  if not coalesce(r @> '{"status":"CALCULATED","after":{"quantity":0.0000002,"remainingCost":0.000002,"roundingAdjusted":false}}', false)
    then raise exception 'Fund residual rounded as stock dust: %', r; end if;
  r := public.simulate_investment_sale(uid, '{"assetType":"THAI_STOCK","accountNumber":"SIM-A","symbol":"SIMCLOSED","exchange":null,"currency":"THB","action":"SELL","quantity":1,"price":40,"tradeDate":"2026-10-27"}');
  if r->>'errorCode' is distinct from 'SIMULATION_POSITION_NOT_HELD' then raise exception 'Closed holding accepted'; end if;
  if has_function_privilege('authenticated', 'public.simulate_investment_sale(uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.simulate_investment_sale(uuid,jsonb)', 'EXECUTE')
    then raise exception 'Simulation RPC exposed to public caller-supplied user'; end if;
end $$;
rollback;
