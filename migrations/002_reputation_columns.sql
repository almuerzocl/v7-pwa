-- Ensure reputation columns exist on profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reservation_reputation integer DEFAULT 100;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS takeaway_reputation integer DEFAULT 100;
