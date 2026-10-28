-- Hardening: pin search_path on the two helper functions (advisor 0011).
-- The two RPCs already set search_path = public; these helpers did not.

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.current_period()
returns date language sql stable set search_path = public as $$
  select date_trunc('month', now())::date;
$$;
