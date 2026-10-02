-- Room Guard / Home: Supabase schema (v2)
-- Paste the whole file into the SQL editor of your Supabase project and run it.
-- It is safe to run again later: every statement is "create if not exists" or
-- "drop + create" for policies.
--
-- Access model: the site runs in the browser with the public anon key, so
-- every table is protected by row level security and only *authenticated*
-- users (your one household account, signed in with email + password) can
-- read or write. Create that user under Authentication > Users ("Add user",
-- tick "Auto confirm") and disable public sign-ups under
-- Authentication > Providers > Email.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- people
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  height_cm numeric,
  weight_kg numeric,
  hair_length text not null default 'short' check (hair_length in ('bald', 'short', 'medium', 'long')),
  age_group text check (age_group is null or age_group in ('baby', 'child', 'teen', 'adult')),
  face_descriptors jsonb not null default '[]'::jsonb, -- array of 128-float arrays
  face_thumbs jsonb not null default '[]'::jsonb,      -- small JPEG data URLs, one per descriptor (null when unknown)
  samples jsonb not null default '[]'::jsonb,          -- [{t, height, build, hair, source}]
  color text default '#4ade80',
  alert_on_enter boolean not null default false,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Existing databases created before face thumbnails existed:
alter table public.profiles add column if not exists face_thumbs jsonb not null default '[]'::jsonb;
alter table public.profiles add column if not exists age_group text;

-- ---------------------------------------------------------------- visits
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  verdict text not null default 'person' check (verdict in ('person', 'known', 'ambiguous', 'unknown', 'insufficient')),
  person_id uuid references public.profiles (id) on delete set null,
  person_name text,
  confidence numeric,
  features jsonb not null default '{}'::jsonb,         -- summarizeTrack() output
  clip_path text,                                       -- first clip part inside the "clips" bucket
  clip_paths jsonb not null default '[]'::jsonb,        -- all parts of a long visit, in order
  snapshot_path text,
  alarm_triggered boolean not null default false,
  lock_triggered boolean not null default false,
  confirmed_person_id uuid references public.profiles (id) on delete set null,
  camera_label text
);
create index if not exists events_started_at_idx on public.events (started_at desc);
-- Existing databases:
alter table public.events add column if not exists clip_paths jsonb not null default '[]'::jsonb;
alter table public.events drop constraint if exists events_verdict_check;
alter table public.events add constraint events_verdict_check check (verdict in ('person', 'known', 'ambiguous', 'unknown', 'insufficient'));

-- ---------------------------------------------------------------- cameras / calibration
create table if not exists public.cameras (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  calibration jsonb,                                    -- fitCalibration() output
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- the room itself (one row)
-- Mode, armed flag and alarm live here so the dashboard, the camera app and
-- the home agent all see the same thing, even when one of them is offline.
create table if not exists public.home (
  id text primary key default 'main',
  room_name text not null default 'My room',
  mode text not null default 'home' check (mode in ('home', 'away', 'sleep', 'guest')),
  mode_since timestamptz not null default now(),
  armed boolean not null default false,
  alarm boolean not null default false,
  alarm_at timestamptz,
  automations jsonb not null default '{}'::jsonb,       -- {"intruder": {"enabled": true}, ...} overrides of the built-in rules
  updated_at timestamptz not null default now()
);
insert into public.home (id) values ('main') on conflict (id) do nothing;

-- ---------------------------------------------------------------- devices, mirrored by the home agent
create table if not exists public.device_states (
  device text primary key,                              -- door | ac | lights | switches | sensors | weather | minecraft | notify | agent | scenes | automations
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- activity timeline
create table if not exists public.activity (
  id bigint generated by default as identity primary key,
  at timestamptz not null default now(),
  kind text not null,                                   -- visit | alarm | security | door | scene | automation | mode | device | notify | minecraft | system
  text text not null,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists activity_at_idx on public.activity (at desc);

-- ---------------------------------------------------------------- table privileges
-- Supabase no longer opens new tables to the Data API automatically
-- (changelog 2026-04-28), so the access the apps need is granted explicitly.
-- Signed-in users get only what the camera app, dashboard and home agent
-- use; signed-out visitors (anon) get nothing. RLS below still applies.
revoke all on public.profiles, public.events, public.cameras, public.home, public.device_states, public.activity from anon, authenticated;
grant select, insert, update, delete on public.profiles, public.events to authenticated;
grant select, insert, update on public.cameras, public.home, public.device_states to authenticated;
grant select, insert on public.activity to authenticated;
grant usage on schema public to authenticated;
do $$
declare seq text := pg_get_serial_sequence('public.activity', 'id');
begin
  if seq is not null then
    execute format('grant usage, select on sequence %s to authenticated', seq);
  end if;
end $$;
grant all on public.profiles, public.events, public.cameras, public.home, public.device_states, public.activity to service_role;

-- ---------------------------------------------------------------- row level security
alter table public.profiles      enable row level security;
alter table public.events        enable row level security;
alter table public.cameras       enable row level security;
alter table public.home          enable row level security;
alter table public.device_states enable row level security;
alter table public.activity      enable row level security;

drop policy if exists "authenticated full access" on public.profiles;
create policy "authenticated full access" on public.profiles
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.events;
create policy "authenticated full access" on public.events
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.cameras;
create policy "authenticated full access" on public.cameras
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.home;
create policy "authenticated full access" on public.home
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.device_states;
create policy "authenticated full access" on public.device_states
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.activity;
create policy "authenticated full access" on public.activity
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------- realtime
-- The dashboard and the camera app listen to row changes on these tables.
do $$
declare t text;
begin
  foreach t in array array['home', 'device_states', 'activity', 'events'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- storage bucket for clips and snapshots
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 104857600, array['video/*', 'image/*'])
on conflict (id) do nothing;

drop policy if exists "authenticated manage clips" on storage.objects;
create policy "authenticated manage clips" on storage.objects
  for all to authenticated
  using (bucket_id = 'clips')
  with check (bucket_id = 'clips');

-- ---------------------------------------------------------------- housekeeping (optional)
-- Keep the tables small. Schedule with pg_cron (Database > Extensions) if you like:
--   select cron.schedule('purge-old-events', '0 4 * * *', $$delete from public.events where started_at < now() - interval '90 days'$$);
--   select cron.schedule('purge-old-activity', '0 4 * * *', $$delete from public.activity where at < now() - interval '30 days'$$);
