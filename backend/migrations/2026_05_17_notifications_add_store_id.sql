-- Add store_id to notifications so that bill-cancel / bill-revise / return-approval
-- notifications stay scoped to the store where the event happened.
--
-- Run this once in the Supabase SQL editor before deploying the new backend.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS store_id character varying;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name   = 'notifications'
      AND constraint_name = 'notifications_store_id_fkey'
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_store_id_fkey
      FOREIGN KEY (store_id) REFERENCES public.stores(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notifications_store_id_idx
  ON public.notifications(store_id);

-- Backfill historical bill notifications by joining on bills.id.
UPDATE public.notifications n
   SET store_id = b.storeid
  FROM public.bills b
 WHERE n.store_id IS NULL
   AND n.related_id IS NOT NULL
   AND n.related_id = b.id
   AND n.type IN ('invoice_cancelled', 'invoice_revised');

-- Backfill historical return notifications by joining on returns.return_id.
UPDATE public.notifications n
   SET store_id = r.store_id
  FROM public.returns r
 WHERE n.store_id IS NULL
   AND n.related_id IS NOT NULL
   AND n.related_id = r.return_id
   AND n.type = 'return_approved';
