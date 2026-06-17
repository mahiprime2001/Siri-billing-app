-- Return-to-Admin (store -> admin) flow.
--   ONE return order  = a row in `returns`            (return_type = 'store_to_admin')
--   MANY product lines = rows in `return_products`     (one per scanned product)
--
-- The Damage flow (store_damage_returns) is intentionally NOT touched here.
-- Shared Supabase: run this ONCE. Safe to re-run (idempotent guards below).

-- 1) Mark the `returns` table so store->admin orders are separable from the
--    existing customer refunds, and track the admin-side workflow status.
ALTER TABLE public.returns
  ADD COLUMN IF NOT EXISTS return_type  text DEFAULT 'customer';
ALTER TABLE public.returns
  ADD COLUMN IF NOT EXISTS admin_status text DEFAULT 'sent_to_admin';

-- 2) New child table: one row per scanned product within a return order.
--    return_id is a logical reference to returns.return_id (not a hard FK, to
--    avoid constraint issues against existing customer-return data).
CREATE TABLE IF NOT EXISTS public.return_products (
  id              character varying PRIMARY KEY,                 -- 'RP-xxxxxxxxxxxx'
  return_id       character varying NOT NULL,                    -- -> returns.return_id
  product_id      character varying NOT NULL REFERENCES public.products(id),
  quantity        integer NOT NULL DEFAULT 0,
  reason          text,                                          -- per-item label
  reason_type     text DEFAULT 'damaged',                        -- damaged|low_sales|modification|other
  verified_qty    integer DEFAULT 0,
  verify_status   text DEFAULT 'pending',                        -- pending|verified|unsent|oversend
  verified_by     character varying REFERENCES public.users(id),
  verified_at     timestamp without time zone,
  holding_status  text DEFAULT 'with_admin',                     -- with_admin|routed_to_damage|sent_out|received
  notes           text,
  created_at      timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_return_products_return  ON public.return_products (return_id);
CREATE INDEX IF NOT EXISTS idx_return_products_product ON public.return_products (product_id);
CREATE INDEX IF NOT EXISTS idx_return_products_holding ON public.return_products (holding_status);
