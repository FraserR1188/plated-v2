-- ============================================================================
-- 20261118170000_whoop_timezone_offset_z_backfill.sql
-- PL-063 — WHOOP 'Z' offsets blank local_date all winter
--
-- WHOOP sends timezone_offset as 'Z' (not '+00:00') whenever the user is on
-- UTC. biometric_periods_resolved only derives local_date for a ±HH:MM
-- offset, so every WHOOP row from 24 Oct 2026 (UK clocks back) had
-- local_date NULL: the Today panel showed "–" for recovery/sleep/strain and
-- the correlation views lost those days. MEASURED on Robbie's account
-- before this migration: whoop_cycles held 99 '+01:00', 5 '+02:00', 25 'Z'
-- (first 'Z' cycle start 2026-10-24 19:34:54Z).
--
-- whoop-sync now normalises 'Z' -> '+00:00' at ingest (normalizeWhoopOffset
-- in _shared/whoop.ts, mirroring health-connect-ingest's
-- normalizeZoneOffsetId). This migration fixes the rows already written.
--
-- ORDER MATTERS: deploy whoop-sync BEFORE pushing this. whoop-sync upserts
-- from WHOOP's payload on every sync (>= 7-day window), so a backfill run
-- against the old function is rewritten back to 'Z' on the next sync.
--
-- Only timezone_offset changes. `raw` keeps WHOOP's original 'Z'. No view
-- changes: the views already read '+00:00' correctly.
-- whoop_recoveries has no timezone_offset column.
-- ============================================================================

update public.whoop_cycles   set timezone_offset = '+00:00' where timezone_offset = 'Z';
update public.whoop_sleeps   set timezone_offset = '+00:00' where timezone_offset = 'Z';
update public.whoop_workouts set timezone_offset = '+00:00' where timezone_offset = 'Z';
