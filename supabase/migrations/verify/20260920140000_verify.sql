-- ============================================================================
-- Verification — 20260920140000_strain_updated_at.sql
-- strain_updated_at on biometric_periods / biometric_periods_resolved
--
-- Run V0 and V6's baseline BEFORE applying. Apply. Run V1-V5 and V7 after,
-- then V6 again.
--
-- Every number below marked RESULT was MEASURED, not predicted: V1-V5 and V7
-- were executed against production inside BEGIN/ROLLBACK as a dry run, then
-- again against the live views after the push. V6 was run by Robbie in the
-- SQL editor, impersonated, before and after.
--
-- V6 MUST be run impersonated. These views have no policies of their own;
-- security_invoker makes them inherit the caller's. Run as `postgres` it
-- returns every user's rows and proves nothing.
--
-- EVERY JOIN TO A whoop_* TABLE BELOW INCLUDES user_id. The PK is
-- (user_id, id) — cycle ids are unique per user, and two production users
-- share id 1806788975. Joining on id alone silently cross-multiplies them,
-- which is exactly how this migration's own justification came to be
-- overstated before the dry run caught it.
-- ============================================================================

--
-- V0 is the BEFORE snapshot; V1-V5 and V7 are the after. Run the pair AS THE
-- SAME ROLE -- one as `postgres` and the other as `authenticated` is not
-- apples-to-apples and can hide a regression.
--
-- EVERY JOIN TO A whoop_* TABLE BELOW INCLUDES user_id. The PK is
-- (user_id, id); joining on id alone silently cross-multiplies users who
-- share a cycle id, which is exactly how this migration's own justification
-- came to be overstated. All four views already do this correctly (audited
-- 2026-09-20); it is ad-hoc queries that get it wrong.
-- ============================================================================

-- V0. BEFORE. Keep the output; V1/V2/V4b/V5 compare against it.
--   select c.relname,
--          count(*) filter (where a.attnum>0 and not a.attisdropped) as cols,
--          md5(string_agg(a.attname, ',' order by a.attnum)
--                filter (where a.attnum>0 and not a.attisdropped)) as list_md5,
--          coalesce(c.reloptions::text,'(none)') as reloptions
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   left join pg_attribute a on a.attrelid=c.oid
--   where n.nspname='public' and c.relname in
--     ('biometric_periods','biometric_periods_resolved',
--      'whoop_correlation','whoop_cycle_nutrition')
--   group by c.relname, c.reloptions order by c.relname;
--
-- MEASURED BEFORE APPLYING (2026-09-20):
--   biometric_periods            26 cols  b6a43bb42c665abfc62b03da34f3e915
--   biometric_periods_resolved   33 cols  4b99645e876436c11d479324362b0938
--   whoop_correlation            75 cols  44bb8ea3ea1bbaf9860e8829bd17ab47
--   whoop_cycle_nutrition        27 cols  b34bcf8cefec0f105e905cce190e3cd3
--   all four: {security_invoker=on}

-- V1. Column counts. EXPECT 27 / 34 / 75 / 27.
--     The two dependents MUST NOT move.
select c.relname,
       count(*) filter (where a.attnum > 0 and not a.attisdropped) as cols
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_attribute a on a.attrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('biometric_periods','biometric_periods_resolved',
                    'whoop_correlation','whoop_cycle_nutrition')
group by c.relname order by c.relname;

-- V2. Append-only: every pre-existing column keeps its name AND position.
--     EXPECT the md5s from V0, unchanged, on all four.
select c.relname,
       md5(string_agg(a.attname, ',' order by a.attnum)
             filter (where a.attnum > 0 and not a.attisdropped
                       and a.attname <> 'strain_updated_at')) as list_md5_excluding_new
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_attribute a on a.attrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('biometric_periods','biometric_periods_resolved',
                    'whoop_correlation','whoop_cycle_nutrition')
group by c.relname order by c.relname;

-- V3. The new column IS the cycle's own timestamp, on every WHOOP row.
--     EXPECT whoop_rows 116, mismatches 0, nulls_on_whoop 0.
--     `is distinct from` so a NULL counts as a mismatch rather than
--     evaluating to NULL and being silently dropped.
select count(*) as whoop_rows,
       count(*) filter (where v.strain_updated_at is distinct from c.whoop_updated_at) as mismatches,
       count(*) filter (where v.strain_updated_at is null) as nulls_on_whoop
from public.biometric_periods_resolved v
join public.whoop_cycles c
  on c.id::text = v.source_period_id
 and c.user_id = v.user_id;          -- REQUIRED: ids are unique per user only

-- V4a. Health Connect frames carry NULL -- the null::timestamptz arm of the
--      UNION ALL. EXPECT hc_rows 367, hc_non_null 0.
--      If hc_rows is 0 this assertion is VACUOUS; say so rather than passing.
select count(*) as hc_rows,
       count(*) filter (where strain_updated_at is not null) as hc_non_null
from public.biometric_periods_resolved v
where not exists (
  select 1 from public.whoop_cycles c
  where c.id::text = v.source_period_id and c.user_id = v.user_id);

-- V4b. security_invoker survived. EXPECT {security_invoker=on} on all four.
--      A view that lost this reads as its OWNER and bypasses every RLS
--      policy underneath -- the one failure here that is a breach, not a bug.
select c.relname, coalesce(c.reloptions::text,'(none)') as reloptions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('biometric_periods','biometric_periods_resolved',
                    'whoop_correlation','whoop_cycle_nutrition')
order by c.relname;

-- V5. Privileges unchanged. CREATE OR REPLACE does not drop the object so
--     grants persist -- asserted, not trusted. EXPECT 12 rows, each
--     DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE.
select table_name, grantee,
       string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('biometric_periods','biometric_periods_resolved',
                     'whoop_correlation','whoop_cycle_nutrition')
  and grantee in ('anon','authenticated','service_role')
group by 1,2 order by 1,2;

-- V6. RLS still fails closed. MUST BE RUN IMPERSONATED, in the SQL editor.
--     These views have no policies of their own; security_invoker makes them
--     inherit the caller's. Run as `postgres` this returns every user's rows
--     and proves nothing.
--
--     MEASURED BEFORE APPLYING (2026-09-20 16:16 BST, impersonating
--     a8435663...): 70 rows, 1 user. Unimpersonated baseline: 479 rows,
--     5 users. That contrast is what makes the check discriminate -- a run
--     that returns the same both ways is not testing RLS.
--
--     EXPECT AFTER: 70 rows, 1 user for the same test user.
--
--     RESULT (2026-09-20 16:27 BST, impersonating a8435663..., run by
--     Robbie): 70 rows, 1 user -- IDENTICAL to the pre-apply baseline.
--     PASS. The migration is verified.
select count(*) as rows_visible, count(distinct user_id) as users_visible
from public.biometric_periods_resolved;

-- V7. Both dependents still resolve and still return what they did.
--     EXPECT 483 and 483.
select (select count(*) from public.whoop_correlation)     as correlation_rows,
       (select count(*) from public.whoop_cycle_nutrition) as cycle_nutrition_rows;


-- ============================================================================
-- MANUAL TEST CHECKLIST (device, after the caption ships)
--
--   [ ] A day with strain shows "as of HH:MM" when that timestamp is today.
--   [ ] A day whose strain was last calculated on another day shows
--       "as of Fri HH:MM" -- the short weekday, not a date.
--   [ ] The time matches when WHOOP last updated that day's strain (check
--       against the WHOOP app's own view of the cycle).
--   [ ] A Health-Connect-only day shows NO caption (strain_updated_at NULL).
--   [ ] A future day shows no caption and no strain -- just the dash, with
--       the ring still in place.
--   [ ] A day with a pending strain score shows no caption: a timestamp
--       under a dash claims the dash is fresh.
-- ============================================================================
