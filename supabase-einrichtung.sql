-- Einmalig im Supabase "SQL Editor" einfügen und auf "Run" klicken.
-- Legt den Speicher für Aufgaben, Termine, Kunden und Fotos an.
-- Jeder angemeldete Nutzer sieht nur seine eigenen Einträge.

create table if not exists public.eintraege (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists eintraege_user_updated on public.eintraege (user_id, updated_at);

alter table public.eintraege enable row level security;
drop policy if exists "eigene Eintraege" on public.eintraege;
create policy "eigene Eintraege" on public.eintraege
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.eintraege_zeitstempel() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists eintraege_zeitstempel on public.eintraege;
create trigger eintraege_zeitstempel before insert or update on public.eintraege
  for each row execute function public.eintraege_zeitstempel();

-- Fotos (privat, nur für den eigenen Ordner)
insert into storage.buckets (id, name, public) values ('fotos', 'fotos', false)
  on conflict (id) do nothing;
drop policy if exists "fotos lesen" on storage.objects;
drop policy if exists "fotos hochladen" on storage.objects;
drop policy if exists "fotos aendern" on storage.objects;
drop policy if exists "fotos loeschen" on storage.objects;
create policy "fotos lesen" on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "fotos hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "fotos aendern" on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "fotos loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
