-- Room Guard: Supabase schema (v1)
-- Run this in the Supabase SQL editor of a fresh project.
--
-- Access model: the site runs in the browser with the public anon key, so
-- every table is protected by row level security and only *authenticated*
-- users (you, signed in with email + password from the Settings tab) can read
-- or write. Create your user under Authentication > Users in the dashboard and
-- disable public sign-ups under Authentication > Providers > Email.

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

-- ---------------------------------------------------------------- row level security
alter table public.profiles enable row level security;
alter table public.events   enable row level security;
alter table public.cameras  enable row level security;

drop policy if exists "authenticated full access" on public.profiles;
create policy "authenticated full access" on public.profiles
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.events;
create policy "authenticated full access" on public.events
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.cameras;
create policy "authenticated full access" on public.cameras
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------- storage bucket for clips and snapshots
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 104857600, array['video/*', 'image/*'])
on conflict (id) do nothing;

drop policy if exists "authenticated manage clips" on storage.objects;
create policy "authenticated manage clips" on storage.objects
  for all to authenticated
  using (bucket_id = 'clips')
  with check (bucket_id = 'clips');

-- Optional: keep the events table small by deleting visits older than 90 days.
-- Schedule with pg_cron (Database > Extensions) if you want this to run automatically:
--   select cron.schedule('purge-old-events', '0 4 * * *', $$delete from public.events where started_at < now() - interval '90 days'$$);
