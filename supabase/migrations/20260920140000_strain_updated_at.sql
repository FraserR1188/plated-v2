-- ============================================================================
-- strain_updated_at on biometric_periods / biometric_periods_resolved
--
-- WHY. The panel on Today wants to caption strain with "as of HH:MM". The
-- only timestamp these views expose is `source_updated_at`, which
-- biometric_periods defines as
--
--     GREATEST(c.whoop_updated_at, r.whoop_updated_at, s.whoop_updated_at)
--
-- -- a freshness signal for the WHOLE FRAME (cycle + recovery + sleep), not
-- for any one metric. Captioning strain with it would show the SLEEP scoring
-- time whenever sleep was scored after the cycle.
--
-- THIS IS A BY-CONSTRUCTION FIX, NOT A CORRECTIVE ONE. Measured on
-- production before this migration: 116 WHOOP rows, ZERO divergence --
-- source_updated_at equals the cycle's own whoop_updated_at on every row,
-- and across all 116 cycles neither recovery nor sleep is ever newer than
-- its cycle. So this column changes no value visible today. It exists so the
-- caption is right by construction rather than by WHOOP's current
-- behaviour, which nothing enforces.
--
-- (An earlier note claimed 1.2% divergence, up to 17.6 hours. That was
-- WRONG: it came from joining whoop_cycles on `id` alone. The PK is
-- (user_id, id) -- WHOOP cycle ids are unique PER USER, and two users
-- genuinely share id 1806788975 -- so the join cross-multiplied them. The
-- dry run of this migration is what caught it, via a negative drift that
-- GREATEST() makes impossible.)
--
-- So: a per-metric column. `strain_updated_at` is the CYCLE's own
-- whoop_updated_at, because strain lives on the cycle (see the "strain lives
-- on the cycle" comment in 20260808150000_biometric_spine_views.sql).
--
-- `source_updated_at` IS DELIBERATELY UNCHANGED. whoop_correlation and
-- whoop_cycle_nutrition read it and must keep seeing exactly what they see
-- today. This migration only ADDS.
--
-- SHAPE. Both view bodies below were generated from live pg_get_viewdef()
-- output, not retyped from the migration files, so the only differences from
-- what is deployed are the added strain_updated_at lines. The diff is nine
-- added lines plus two trailing commas -- nothing else moves.
--
-- APPEND-ONLY, ON PURPOSE. CREATE OR REPLACE VIEW can only add columns at
-- the END of the list. In the final select of biometric_periods_resolved the
-- new column is therefore LAST, after sleep_source_record_id, rather than
-- beside source_updated_at where it reads more naturally -- putting it there
-- would shift sleep_source_record_id from 33 to 34 and be rejected. In the
-- intermediate CTEs position is internal and it sits beside its sibling.
--
-- THE UNION ALL. biometric_periods_resolved unions a WHOOP arm with a
-- synthetic / Health Connect arm. The HC arm has no cycle and therefore no
-- strain calculation time, so it selects NULL::timestamptz -- exactly as it
-- already does for source_updated_at. Both sides must carry the column or
-- the union's column lists do not line up and the view fails to create.
--
-- security_invoker IS STATED EXPLICITLY on both. These views have no RLS of
-- their own; they rely entirely on the invoker's policies on the underlying
-- tables, so a view that silently lost the option would become a
-- cross-user read. It is not assumed to survive CREATE OR REPLACE -- it is
-- restated here and asserted in V4 below.
--
-- NO GRANTS ARE RESTATED. CREATE OR REPLACE does not drop the object, so
-- privileges persist. V5 asserts that rather than trusting it.
-- ============================================================================

create or replace view public.biometric_periods
with (security_invoker = on) as
SELECT c.user_id,
    'whoop'::text AS ingest_transport,
    'whoop.direct'::text AS origin_package,
    c.id::text AS source_period_id,
    c.start AS period_start,
    c."end" AS period_end,
    c."end" IS NULL AS is_current,
    c.timezone_offset,
    ((c.start AT TIME ZONE 'UTC'::text) + c.timezone_offset::interval)::date AS local_date,
    c.kilojoule AS cycle_energy_kilojoule,
    c.average_heart_rate AS cycle_average_heart_rate,
    c.max_heart_rate AS cycle_max_heart_rate,
    r.recovery_score,
    r.score_state AS recovery_score_state,
    r.hrv_rmssd_milli AS hrv,
    'rmssd'::text AS hrv_method,
    'ms'::text AS hrv_unit,
    r.resting_heart_rate,
    r.spo2_percentage,
    r.skin_temp_celsius,
    r.user_calibrating,
    c.strain,
    c.score_state AS strain_score_state,
    s.sleep_performance_percentage AS sleep_performance,
    s.score_state AS sleep_score_state,
    GREATEST(c.whoop_updated_at, r.whoop_updated_at, s.whoop_updated_at) AS source_updated_at,
    c.whoop_updated_at AS strain_updated_at
   FROM whoop_cycles c
     LEFT JOIN whoop_recoveries r ON r.user_id = c.user_id AND r.cycle_id = c.id
     LEFT JOIN whoop_sleeps s ON s.user_id = r.user_id AND s.id = r.sleep_id;

create or replace view public.biometric_periods_resolved
with (security_invoker = on) as
WITH whoop_periods AS (
         SELECT p.user_id,
            p.source_period_id,
            p.period_start AS cycle_start,
            p.period_end AS cycle_end,
            p.is_current,
            p.timezone_offset,
            p.ingest_transport,
            p.origin_package,
            p.cycle_energy_kilojoule,
            p.cycle_average_heart_rate,
            p.cycle_max_heart_rate,
            p.strain,
            p.strain_score_state,
            p.recovery_score,
            p.recovery_score_state,
            p.spo2_percentage,
            p.skin_temp_celsius,
            p.user_calibrating,
            p.source_updated_at,
            p.strain_updated_at,
            p.sleep_performance,
            p.sleep_score_state,
            p.hrv,
            p.hrv_method,
            p.hrv_unit,
            p.resting_heart_rate,
            s."end" AS wake_at,
            s.timezone_offset AS wake_timezone_offset
           FROM biometric_periods p
             LEFT JOIN whoop_recoveries r ON r.user_id = p.user_id AND r.cycle_id::text = p.source_period_id
             LEFT JOIN whoop_sleeps s ON s.user_id = r.user_id AND s.id = r.sleep_id
          WHERE p.ingest_transport = 'whoop'::text
        ), synthetic_periods AS (
         SELECT sc.user_id,
            sc.source_period_id,
            sc.cycle_start,
            sc.cycle_end,
            sc.is_current,
            sc.timezone_offset,
            sc.ingest_transport,
            sc.origin_package,
            NULL::numeric AS cycle_energy_kilojoule,
            NULL::integer AS cycle_average_heart_rate,
            NULL::integer AS cycle_max_heart_rate,
            NULL::numeric AS strain,
            NULL::text AS strain_score_state,
            NULL::numeric AS recovery_score,
            NULL::text AS recovery_score_state,
            NULL::numeric AS spo2_percentage,
            NULL::numeric AS skin_temp_celsius,
            NULL::boolean AS user_calibrating,
            NULL::timestamp with time zone AS source_updated_at,
            NULL::timestamp with time zone AS strain_updated_at,
            NULL::numeric AS sleep_performance,
            NULL::text AS sleep_score_state,
            NULL::numeric AS hrv,
            NULL::text AS hrv_method,
            NULL::text AS hrv_unit,
            NULL::numeric AS resting_heart_rate,
            sc.block_wake_at AS wake_at,
            sc.wake_timezone_offset
           FROM biometric_synthetic_cycles sc
        ), all_periods AS (
         SELECT whoop_periods.user_id,
            whoop_periods.source_period_id,
            whoop_periods.cycle_start,
            whoop_periods.cycle_end,
            whoop_periods.is_current,
            whoop_periods.timezone_offset,
            whoop_periods.ingest_transport,
            whoop_periods.origin_package,
            whoop_periods.cycle_energy_kilojoule,
            whoop_periods.cycle_average_heart_rate,
            whoop_periods.cycle_max_heart_rate,
            whoop_periods.strain,
            whoop_periods.strain_score_state,
            whoop_periods.recovery_score,
            whoop_periods.recovery_score_state,
            whoop_periods.spo2_percentage,
            whoop_periods.skin_temp_celsius,
            whoop_periods.user_calibrating,
            whoop_periods.source_updated_at,
            whoop_periods.strain_updated_at,
            whoop_periods.sleep_performance,
            whoop_periods.sleep_score_state,
            whoop_periods.hrv,
            whoop_periods.hrv_method,
            whoop_periods.hrv_unit,
            whoop_periods.resting_heart_rate,
            whoop_periods.wake_at,
            whoop_periods.wake_timezone_offset
           FROM whoop_periods
        UNION ALL
         SELECT synthetic_periods.user_id,
            synthetic_periods.source_period_id,
            synthetic_periods.cycle_start,
            synthetic_periods.cycle_end,
            synthetic_periods.is_current,
            synthetic_periods.timezone_offset,
            synthetic_periods.ingest_transport,
            synthetic_periods.origin_package,
            synthetic_periods.cycle_energy_kilojoule,
            synthetic_periods.cycle_average_heart_rate,
            synthetic_periods.cycle_max_heart_rate,
            synthetic_periods.strain,
            synthetic_periods.strain_score_state,
            synthetic_periods.recovery_score,
            synthetic_periods.recovery_score_state,
            synthetic_periods.spo2_percentage,
            synthetic_periods.skin_temp_celsius,
            synthetic_periods.user_calibrating,
            synthetic_periods.source_updated_at,
            synthetic_periods.strain_updated_at,
            synthetic_periods.sleep_performance,
            synthetic_periods.sleep_score_state,
            synthetic_periods.hrv,
            synthetic_periods.hrv_method,
            synthetic_periods.hrv_unit,
            synthetic_periods.resting_heart_rate,
            synthetic_periods.wake_at,
            synthetic_periods.wake_timezone_offset
           FROM synthetic_periods
        ), bounded_periods AS (
         SELECT all_periods.user_id,
            all_periods.source_period_id,
            all_periods.cycle_start,
            all_periods.cycle_end,
            all_periods.is_current,
            all_periods.timezone_offset,
            all_periods.ingest_transport,
            all_periods.origin_package,
            all_periods.cycle_energy_kilojoule,
            all_periods.cycle_average_heart_rate,
            all_periods.cycle_max_heart_rate,
            all_periods.strain,
            all_periods.strain_score_state,
            all_periods.recovery_score,
            all_periods.recovery_score_state,
            all_periods.spo2_percentage,
            all_periods.skin_temp_celsius,
            all_periods.user_calibrating,
            all_periods.source_updated_at,
            all_periods.strain_updated_at,
            all_periods.sleep_performance,
            all_periods.sleep_score_state,
            all_periods.hrv,
            all_periods.hrv_method,
            all_periods.hrv_unit,
            all_periods.resting_heart_rate,
            all_periods.wake_at,
            all_periods.wake_timezone_offset,
            COALESCE(all_periods.cycle_end,
                CASE
                    WHEN all_periods.cycle_start > (now() - '36:00:00'::interval) THEN now()
                    ELSE NULL::timestamp with time zone
                END) AS candidate_effective_end
           FROM all_periods
        ), unreconciled_overlaps AS (
         SELECT DISTINCT a.user_id,
            a.source_period_id,
            a.ingest_transport,
            a.origin_package
           FROM bounded_periods a
             JOIN bounded_periods b ON b.user_id = a.user_id AND b.ingest_transport <> a.ingest_transport AND b.cycle_start IS DISTINCT FROM a.cycle_start AND a.cycle_start < b.candidate_effective_end AND b.cycle_start < a.candidate_effective_end
        ), clean_periods AS (
         SELECT bp.user_id,
            bp.source_period_id,
            bp.cycle_start,
            bp.cycle_end,
            bp.is_current,
            bp.timezone_offset,
            bp.ingest_transport,
            bp.origin_package,
            bp.cycle_energy_kilojoule,
            bp.cycle_average_heart_rate,
            bp.cycle_max_heart_rate,
            bp.strain,
            bp.strain_score_state,
            bp.recovery_score,
            bp.recovery_score_state,
            bp.spo2_percentage,
            bp.skin_temp_celsius,
            bp.user_calibrating,
            bp.source_updated_at,
            bp.strain_updated_at,
            bp.sleep_performance,
            bp.sleep_score_state,
            bp.hrv,
            bp.hrv_method,
            bp.hrv_unit,
            bp.resting_heart_rate,
            bp.wake_at,
            bp.wake_timezone_offset,
            bp.candidate_effective_end
           FROM bounded_periods bp
          WHERE NOT (EXISTS ( SELECT 1
                   FROM unreconciled_overlaps u
                  WHERE u.user_id = bp.user_id AND u.source_period_id = bp.source_period_id AND u.ingest_transport = bp.ingest_transport AND u.origin_package = bp.origin_package))
        ), ranked_periods AS (
         SELECT clean_periods.user_id,
            clean_periods.source_period_id,
            clean_periods.cycle_start,
            clean_periods.cycle_end,
            clean_periods.is_current,
            clean_periods.timezone_offset,
            clean_periods.ingest_transport,
            clean_periods.origin_package,
            clean_periods.cycle_energy_kilojoule,
            clean_periods.cycle_average_heart_rate,
            clean_periods.cycle_max_heart_rate,
            clean_periods.strain,
            clean_periods.strain_score_state,
            clean_periods.recovery_score,
            clean_periods.recovery_score_state,
            clean_periods.spo2_percentage,
            clean_periods.skin_temp_celsius,
            clean_periods.user_calibrating,
            clean_periods.source_updated_at,
            clean_periods.strain_updated_at,
            clean_periods.sleep_performance,
            clean_periods.sleep_score_state,
            clean_periods.hrv,
            clean_periods.hrv_method,
            clean_periods.hrv_unit,
            clean_periods.resting_heart_rate,
            clean_periods.wake_at,
            clean_periods.wake_timezone_offset,
            clean_periods.candidate_effective_end,
            row_number() OVER (PARTITION BY clean_periods.user_id, clean_periods.cycle_start ORDER BY (clean_periods.ingest_transport = 'whoop'::text) DESC, clean_periods.origin_package) AS rn
           FROM clean_periods
        ), frame_cycles AS (
         SELECT ranked_periods.user_id,
            ranked_periods.source_period_id,
            ranked_periods.cycle_start,
            ranked_periods.cycle_end,
            ranked_periods.candidate_effective_end AS effective_end,
            ranked_periods.is_current,
            ranked_periods.timezone_offset,
            ranked_periods.ingest_transport AS frame_ingest_transport,
            ranked_periods.origin_package AS frame_origin_package,
            ranked_periods.cycle_energy_kilojoule,
            ranked_periods.cycle_average_heart_rate,
            ranked_periods.cycle_max_heart_rate,
            ranked_periods.strain,
            ranked_periods.strain_score_state,
            ranked_periods.recovery_score,
            ranked_periods.recovery_score_state,
            ranked_periods.spo2_percentage,
            ranked_periods.skin_temp_celsius,
            ranked_periods.user_calibrating,
            ranked_periods.source_updated_at,
            ranked_periods.strain_updated_at,
            ranked_periods.sleep_performance AS whoop_sleep_performance,
            ranked_periods.sleep_score_state AS whoop_sleep_score_state,
            ranked_periods.hrv AS whoop_hrv,
            ranked_periods.hrv_method AS whoop_hrv_method,
            ranked_periods.hrv_unit AS whoop_hrv_unit,
            ranked_periods.resting_heart_rate AS whoop_resting_heart_rate,
            ranked_periods.ingest_transport AS whoop_or_hc,
                CASE
                    WHEN ranked_periods.wake_timezone_offset ~ '^[+-]\d{2}:\d{2}(:\d{2})?$'::text THEN ((ranked_periods.wake_at AT TIME ZONE 'UTC'::text) + ranked_periods.wake_timezone_offset::interval)::date
                    ELSE NULL::date
                END AS local_date
           FROM ranked_periods
          WHERE ranked_periods.rn = 1
        ), sleep_candidates AS (
         SELECT frame_cycles.user_id,
            frame_cycles.source_period_id AS frame_key,
            frame_cycles.whoop_sleep_performance AS sleep_performance,
            frame_cycles.whoop_sleep_score_state AS sleep_score_state,
            'whoop'::text AS ingest_transport,
            'whoop.direct'::text AS origin_package,
            NULL::text AS source_record_id
           FROM frame_cycles
          WHERE frame_cycles.whoop_or_hc = 'whoop'::text AND frame_cycles.whoop_sleep_performance IS NOT NULL
        UNION ALL
         SELECT fc_1.user_id,
            fc_1.source_period_id AS frame_key,
            NULL::numeric AS sleep_performance,
            NULL::text AS sleep_score_state,
            'health_connect'::text AS ingest_transport,
            s.origin_package,
            s.provider_record_id AS source_record_id
           FROM biometric_sleep_sessions s
             JOIN frame_cycles fc_1 ON fc_1.user_id = s.user_id AND (s.period_start + (s.period_end - s.period_start) / 2::double precision) >= fc_1.cycle_start AND fc_1.effective_end IS NOT NULL AND (s.period_start + (s.period_end - s.period_start) / 2::double precision) < fc_1.effective_end
          WHERE s.ingest_transport = 'health_connect'::text
        ), sleep_ranked AS (
         SELECT sc.user_id,
            sc.frame_key,
            sc.sleep_performance,
            sc.sleep_score_state,
            sc.ingest_transport,
            sc.origin_package,
            sc.source_record_id,
            row_number() OVER (PARTITION BY sc.user_id, sc.frame_key ORDER BY (pref.ingest_transport IS NOT NULL AND pref.ingest_transport = sc.ingest_transport AND pref.origin_package = sc.origin_package) DESC, (sc.origin_package ~~ '%.direct'::text) DESC, sc.origin_package) AS rn
           FROM sleep_candidates sc
             LEFT JOIN biometric_source_preferences pref ON pref.user_id = sc.user_id AND pref.domain = 'sleep'::text
        ), sleep_winner AS (
         SELECT sleep_ranked.user_id,
            sleep_ranked.frame_key,
            sleep_ranked.sleep_performance,
            sleep_ranked.sleep_score_state,
            sleep_ranked.ingest_transport,
            sleep_ranked.origin_package,
            sleep_ranked.source_record_id,
            sleep_ranked.rn
           FROM sleep_ranked
          WHERE sleep_ranked.rn = 1
        ), hrv_candidates AS (
         SELECT frame_cycles.user_id,
            frame_cycles.source_period_id AS frame_key,
            frame_cycles.whoop_hrv AS hrv,
            frame_cycles.whoop_hrv_method AS hrv_method,
            frame_cycles.whoop_hrv_unit AS hrv_unit,
            'whoop'::text AS ingest_transport,
            'whoop.direct'::text AS origin_package
           FROM frame_cycles
          WHERE frame_cycles.whoop_or_hc = 'whoop'::text AND frame_cycles.whoop_hrv IS NOT NULL
        UNION ALL
         SELECT fc_1.user_id,
            fc_1.source_period_id AS frame_key,
            h.hrv_value AS hrv,
            h.hrv_method,
            h.hrv_unit,
            'health_connect'::text AS ingest_transport,
            h.origin_package
           FROM biometric_hrv_samples h
             JOIN frame_cycles fc_1 ON fc_1.user_id = h.user_id AND h.measured_at >= fc_1.cycle_start AND fc_1.effective_end IS NOT NULL AND h.measured_at < fc_1.effective_end
          WHERE h.ingest_transport = 'health_connect'::text
        ), hrv_ranked AS (
         SELECT hc.user_id,
            hc.frame_key,
            hc.hrv,
            hc.hrv_method,
            hc.hrv_unit,
            hc.ingest_transport,
            hc.origin_package,
            row_number() OVER (PARTITION BY hc.user_id, hc.frame_key ORDER BY (pref.ingest_transport IS NOT NULL AND pref.ingest_transport = hc.ingest_transport AND pref.origin_package = hc.origin_package) DESC, (hc.origin_package ~~ '%.direct'::text) DESC, hc.origin_package) AS rn
           FROM hrv_candidates hc
             LEFT JOIN biometric_source_preferences pref ON pref.user_id = hc.user_id AND pref.domain = 'hrv'::text
        ), hrv_winner AS (
         SELECT hrv_ranked.user_id,
            hrv_ranked.frame_key,
            hrv_ranked.hrv,
            hrv_ranked.hrv_method,
            hrv_ranked.hrv_unit,
            hrv_ranked.ingest_transport,
            hrv_ranked.origin_package,
            hrv_ranked.rn
           FROM hrv_ranked
          WHERE hrv_ranked.rn = 1
        ), resting_hr_candidates AS (
         SELECT frame_cycles.user_id,
            frame_cycles.source_period_id AS frame_key,
            frame_cycles.whoop_resting_heart_rate AS resting_heart_rate,
            'whoop'::text AS ingest_transport,
            'whoop.direct'::text AS origin_package
           FROM frame_cycles
          WHERE frame_cycles.whoop_or_hc = 'whoop'::text AND frame_cycles.whoop_resting_heart_rate IS NOT NULL
        UNION ALL
         SELECT fc_1.user_id,
            fc_1.source_period_id AS frame_key,
            r.resting_heart_rate,
            'health_connect'::text AS ingest_transport,
            r.origin_package
           FROM biometric_resting_hr r
             JOIN frame_cycles fc_1 ON fc_1.user_id = r.user_id AND r.measured_at >= fc_1.cycle_start AND fc_1.effective_end IS NOT NULL AND r.measured_at < fc_1.effective_end
          WHERE r.ingest_transport = 'health_connect'::text
        ), resting_hr_ranked AS (
         SELECT rc.user_id,
            rc.frame_key,
            rc.resting_heart_rate,
            rc.ingest_transport,
            rc.origin_package,
            row_number() OVER (PARTITION BY rc.user_id, rc.frame_key ORDER BY (pref.ingest_transport IS NOT NULL AND pref.ingest_transport = rc.ingest_transport AND pref.origin_package = rc.origin_package) DESC, (rc.origin_package ~~ '%.direct'::text) DESC, rc.origin_package) AS rn
           FROM resting_hr_candidates rc
             LEFT JOIN biometric_source_preferences pref ON pref.user_id = rc.user_id AND pref.domain = 'resting_hr'::text
        ), resting_hr_winner AS (
         SELECT resting_hr_ranked.user_id,
            resting_hr_ranked.frame_key,
            resting_hr_ranked.resting_heart_rate,
            resting_hr_ranked.ingest_transport,
            resting_hr_ranked.origin_package,
            resting_hr_ranked.rn
           FROM resting_hr_ranked
          WHERE resting_hr_ranked.rn = 1
        )
 SELECT fc.user_id,
    fc.source_period_id,
    fc.cycle_start AS period_start,
    fc.cycle_end AS period_end,
    fc.is_current,
    fc.timezone_offset,
    fc.local_date,
    fc.frame_ingest_transport AS period_ingest_transport,
    fc.frame_origin_package AS period_origin_package,
    fc.cycle_energy_kilojoule,
    fc.cycle_average_heart_rate,
    fc.cycle_max_heart_rate,
    fc.recovery_score,
    fc.recovery_score_state,
    fc.spo2_percentage,
    fc.skin_temp_celsius,
    fc.user_calibrating,
    fc.strain,
    fc.strain_score_state,
    sw.sleep_performance,
    sw.sleep_score_state,
    sw.ingest_transport AS sleep_ingest_transport,
    sw.origin_package AS sleep_origin_package,
    hw.hrv,
    hw.hrv_method,
    hw.hrv_unit,
    hw.ingest_transport AS hrv_ingest_transport,
    hw.origin_package AS hrv_origin_package,
    rw.resting_heart_rate,
    rw.ingest_transport AS resting_hr_ingest_transport,
    rw.origin_package AS resting_hr_origin_package,
    fc.source_updated_at,
    sw.source_record_id AS sleep_source_record_id,
    fc.strain_updated_at
   FROM frame_cycles fc
     LEFT JOIN sleep_winner sw ON sw.user_id = fc.user_id AND sw.frame_key = fc.source_period_id
     LEFT JOIN hrv_winner hw ON hw.user_id = fc.user_id AND hw.frame_key = fc.source_period_id
     LEFT JOIN resting_hr_winner rw ON rw.user_id = fc.user_id AND rw.frame_key = fc.source_period_id;

-- ============================================================================
-- VERIFICATION
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
