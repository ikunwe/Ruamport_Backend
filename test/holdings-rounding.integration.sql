-- Run after 011 on a development PostgreSQL/Supabase database.
-- Pure function checks; no financial rows are inserted or updated.
begin;
do $$
declare
  test_case record;
  actual numeric;
begin
  for test_case in select * from (values
    (0.0000003::numeric, 1::numeric, 0.9999997::numeric, 0::bigint, false, 0::numeric),
    (-0.0000003, 1, 1.0000003, 0, false, 0),
    (0.0000002, 1, 0.9999998, 0, false, 0),
    (-0.0000002, 1, 1.0000002, 0, false, 0),
    (0.00000031, 1, 0.99999969, 0, false, 0.00000031),
    (0.0000005, 1, 0.9999995, 0, false, 0.0000005),
    (-0.0000005, 1, 1.0000005, 0, false, -0.0000005),
    (0.0000002, 0.0000002, 0, 0, false, 0.0000002),
    (-0.0000002, 0, 0.0000002, 0, false, -0.0000002),
    (0.0000002, 1, 0.9999998, 1, false, 0.0000002),
    (0.0000002, 1, 0.9999998, 0, true, 0.0000002),
    (0, 1, 1, 0, false, 0),
    (2, 3, 1, 0, false, 2)
  ) as cases(raw_quantity, bought, sold, excluded, collision, expected) loop
    actual := public.stock_display_quantity(test_case.raw_quantity, test_case.bought,
      test_case.sold, test_case.excluded, test_case.collision);
    if actual is distinct from test_case.expected then
      raise exception 'Rounding failed: raw %, expected %, got %', test_case.raw_quantity, test_case.expected, actual;
    end if;
  end loop;
  raise notice 'All rounding boundary checks passed';
end;
$$;
rollback;
