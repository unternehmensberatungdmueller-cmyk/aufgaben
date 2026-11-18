-- Einmalig im Supabase "SQL Editor" einfügen und auf "Run" klicken.
-- Speicher für die Google-Verbindung. Nur der Server (Edge Function "google") kommt daran,
-- die App selbst kann diese Tabelle weder lesen noch ändern.

create table if not exists public.google_konto (
  user_id       uuid primary key references auth.users on delete cascade,
  refresh_token text not null,
  email         text,
  updated_at    timestamptz not null default now()
);
alter table public.google_konto enable row level security;
-- Absichtlich keine Regeln (policies): damit ist der Zugriff aus der App gesperrt.
