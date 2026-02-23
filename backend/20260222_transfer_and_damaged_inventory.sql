-- Transfer-order + verification + damaged inventory lifecycle migration

ALTER TABLE IF EXISTS public.returns
  ADD COLUMN IF NOT EXISTS store_id character varying,
  ADD COLUMN IF NOT EXISTS is_damaged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS damaged_qty integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_reason text;

ALTER TABLE IF EXISTS public.replacements
  ADD COLUMN IF NOT EXISTS is_damaged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS damaged_qty integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_reason text;

CREATE TABLE IF NOT EXISTS public.inventory_transfer_orders (
  id character varying PRIMARY KEY,
  store_id character varying NOT NULL REFERENCES public.stores(id),
  source_type character varying DEFAULT 'manual',
  source_store_id character varying REFERENCES public.stores(id),
  source_location_ref text,
  created_by character varying REFERENCES public.users(id),
  status character varying DEFAULT 'pending',
  notes text,
  version_number integer DEFAULT 1,
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  verified_at timestamp without time zone,
  cancelled_at timestamp without time zone,
  cancelled_by character varying
);

CREATE TABLE IF NOT EXISTS public.inventory_transfer_items (
  id character varying PRIMARY KEY,
  transfer_order_id character varying NOT NULL REFERENCES public.inventory_transfer_orders(id),
  product_id character varying NOT NULL REFERENCES public.products(id),
  assigned_qty integer NOT NULL DEFAULT 0,
  verified_qty integer NOT NULL DEFAULT 0,
  damaged_qty integer NOT NULL DEFAULT 0,
  wrong_store_qty integer NOT NULL DEFAULT 0,
  applied_verified_qty integer NOT NULL DEFAULT 0,
  status character varying DEFAULT 'pending',
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.inventory_transfer_scans (
  id character varying PRIMARY KEY,
  transfer_item_id character varying NOT NULL REFERENCES public.inventory_transfer_items(id),
  barcode character varying,
  quantity integer NOT NULL DEFAULT 1,
  entry_mode character varying DEFAULT 'manual',
  event_type character varying DEFAULT 'verified',
  entered_by character varying REFERENCES public.users(id),
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.inventory_transfer_verifications (
  verification_session_id character varying PRIMARY KEY,
  order_id character varying NOT NULL REFERENCES public.inventory_transfer_orders(id),
  store_id character varying NOT NULL REFERENCES public.stores(id),
  submitted_by character varying REFERENCES public.users(id),
  submitted_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  status character varying DEFAULT 'pending',
  payload_hash character varying,
  error_message text
);

CREATE TABLE IF NOT EXISTS public.damaged_inventory_events (
  id character varying PRIMARY KEY,
  store_id character varying REFERENCES public.stores(id),
  product_id character varying REFERENCES public.products(id),
  quantity integer NOT NULL DEFAULT 0,
  source_type character varying NOT NULL,
  source_id character varying,
  reason text,
  status character varying DEFAULT 'reported',
  resolution_type character varying,
  resolution_notes text,
  reported_by character varying REFERENCES public.users(id),
  resolved_by character varying REFERENCES public.users(id),
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  resolved_at timestamp without time zone
);

CREATE INDEX IF NOT EXISTS idx_transfer_orders_store_status
  ON public.inventory_transfer_orders (store_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_items_order
  ON public.inventory_transfer_items (transfer_order_id);
CREATE INDEX IF NOT EXISTS idx_transfer_items_product
  ON public.inventory_transfer_items (product_id);
CREATE INDEX IF NOT EXISTS idx_transfer_scans_item
  ON public.inventory_transfer_scans (transfer_item_id);
CREATE INDEX IF NOT EXISTS idx_transfer_verifications_order
  ON public.inventory_transfer_verifications (order_id);
CREATE INDEX IF NOT EXISTS idx_damaged_events_store_status
  ON public.damaged_inventory_events (store_id, status);

CREATE OR REPLACE VIEW public.v_inventory_transfer_item_progress AS
SELECT
  i.*,
  GREATEST(0, i.assigned_qty - i.verified_qty - i.damaged_qty - i.wrong_store_qty) AS missing_qty
FROM public.inventory_transfer_items i;
