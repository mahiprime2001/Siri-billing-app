-- Supabase conflict-guard migration
-- Adds optimistic concurrency column and auto-maintained timestamps.

ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS public.products ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS public.customers ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS public.stores ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS public.systemsettings ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.bump_version_and_updatedat()
RETURNS trigger AS $$
BEGIN
  NEW.version = COALESCE(OLD.version, 1) + 1;
  NEW.updatedat = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.bump_version_and_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.version = COALESCE(OLD.version, 1) + 1;
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_conflict_guard ON public.users;
CREATE TRIGGER trg_users_conflict_guard
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_updatedat();

DROP TRIGGER IF EXISTS trg_products_conflict_guard ON public.products;
CREATE TRIGGER trg_products_conflict_guard
BEFORE UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_updatedat();

DROP TRIGGER IF EXISTS trg_customers_conflict_guard ON public.customers;
CREATE TRIGGER trg_customers_conflict_guard
BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_updatedat();

DROP TRIGGER IF EXISTS trg_stores_conflict_guard ON public.stores;
CREATE TRIGGER trg_stores_conflict_guard
BEFORE UPDATE ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_updatedat();

DROP TRIGGER IF EXISTS trg_systemsettings_conflict_guard ON public.systemsettings;
CREATE TRIGGER trg_systemsettings_conflict_guard
BEFORE UPDATE ON public.systemsettings
FOR EACH ROW EXECUTE FUNCTION public.bump_version_and_updated_at();
