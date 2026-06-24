-- Fix intermittent "Insufficient stock for one or more products" (HTTP 400) on
-- bill creation.
--
-- ROOT CAUSE: storeinventory has no unique constraint on (storeid, productid),
-- and every write path (initial assignment, transfer verification, drift
-- reconcile, offline-queue replay, sync) uses a non-atomic "read -> if missing,
-- insert" pattern. Whenever the existence check misses the existing row (a
-- racing/offline-replayed/re-synced write), a SECOND row is inserted instead of
-- updating the first. That leaves two rows for the same product in the same
-- store with independent quantities (e.g. 6 and 0).
--
-- The bill stock-check builds a {productid -> quantity} map and the LAST row
-- wins. Because row order is not deterministic, the 0-row sometimes wins and the
-- sale is rejected, and sometimes the 6-row wins and it succeeds -> the
-- "sometimes I can't generate an invoice" symptom. Deleting the local json
-- folder only reshuffles which cached row is shown, so it masks it temporarily.
--
-- Run this once in the Supabase SQL editor BEFORE deploying the new backend.

-- 1) Inspect the damage first (optional — read-only).
-- SELECT storeid, productid, count(*) AS rows,
--        array_agg(quantity ORDER BY updatedat) AS quantities,
--        array_agg(updatedat ORDER BY updatedat) AS updated
--   FROM public.storeinventory
--  GROUP BY storeid, productid
-- HAVING count(*) > 1
--  ORDER BY count(*) DESC;

-- 2) De-duplicate: keep exactly ONE row per (storeid, productid) — the most
--    recently updated one (tie-break on id) — and delete the older duplicates.
DELETE FROM public.storeinventory s
USING (
    SELECT id
      FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY storeid, productid
                       ORDER BY updatedat DESC NULLS LAST, id DESC
                   ) AS rn
              FROM public.storeinventory
           ) ranked
     WHERE ranked.rn > 1
) dupes
WHERE s.id = dupes.id;

-- 3) Prevent it from ever happening again: one row per product per store.
--    After this, the "if missing, insert" paths that occasionally raced will
--    have their stray duplicate INSERT rejected (those code paths already
--    log-and-continue), instead of silently creating a second row.
CREATE UNIQUE INDEX IF NOT EXISTS storeinventory_store_product_uidx
    ON public.storeinventory (storeid, productid);

-- 4) Verify there are no duplicates left (should return zero rows).
-- SELECT storeid, productid, count(*)
--   FROM public.storeinventory
--  GROUP BY storeid, productid
-- HAVING count(*) > 1;
