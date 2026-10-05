-- Ritual Log — shared week, rituals and runs (Postgres / Supabase).
--
-- One person, two devices (phone + laptop), plus Hermes as a second writer.
-- Every row carries user_id so every RLS policy is one rule: user_id = auth.uid().
--
-- Editing rules this schema is built around:
--   * The week (goals, days, rituals, anchors) is editable from the app and by
--     Hermes. Last write wins per row, ordered by updated_at (the trigger keeps
--     it honest), so neither writer can silently roll the other back.
--   * Deletions are tombstones (deleted = true), never row removal: Hermes
--     regenerating a week must not resurrect a ritual Rodri deleted.
--   * source says who owns the row. Hermes never overwrites a row it does not
--     own; it only inserts what is missing and updates its own.
--   * runs keep the app's existing key shape '<ritual_key>:<scope>' as their id,
--     which makes re-importing the gist document idempotent.

create extension if not exists pgcrypto;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- the week

create table if not exists weeks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  iso               text not null,                    -- '2026-W41'
  label             text not null default '',         -- 'Week 41'
  starts_on         date not null,
  ends_on           date not null,
  reserve_saturday  boolean not null default false,
  updated_at        timestamptz not null default now(),
  unique (user_id, iso)
);

create table if not exists week_days (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  week_id     uuid not null references weeks(id) on delete cascade,
  day_code    text not null check (day_code in ('mon','tue','wed','thu','fri','sat','sun')),
  day_date    date not null,
  work_a      text,
  work_b      text,
  note        text,
  deleted     boolean not null default false,
  source      text not null default 'hermes' check (source in ('hermes','app')),
  updated_at  timestamptz not null default now(),
  unique (week_id, day_code)
);

create table if not exists goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  week_id        uuid not null references weeks(id) on delete cascade,
  project        text not null default '',
  headline       text not null default '',
  detail         text not null default '',
  is_completion  boolean not null default false,   -- the 'N/M · %' progress lines
  position       int  not null default 0,
  deleted        boolean not null default false,
  source         text not null default 'hermes' check (source in ('hermes','app')),
  updated_at     timestamptz not null default now()
);

create table if not exists rituals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  week_id       uuid not null references weeks(id) on delete cascade,
  ritual_key    text not null,                    -- 'mon-read' — stable across a regeneration
  day_code      text not null,
  title         text not null,
  starts_at     time,
  ends_at       time,
  minutes       int,
  block         text,
  block_window  text,
  kind          text not null default 'ritual'
                check (kind in ('ritual','work','chore','meal','any')),
  position      int  not null default 0,
  steps         jsonb not null default '[{"id":"main","title":""}]'::jsonb,
  deleted       boolean not null default false,
  source        text not null default 'hermes' check (source in ('hermes','app')),
  updated_at    timestamptz not null default now(),
  unique (week_id, ritual_key)
);

create table if not exists anchors (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  week_id     uuid not null references weeks(id) on delete cascade,
  text        text not null,
  position    int  not null default 0,
  deleted     boolean not null default false,
  source      text not null default 'hermes' check (source in ('hermes','app')),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- the runs

create table if not exists runs (
  id          text primary key,                   -- '<ritual_key>:<scope>'
  user_id     uuid not null references auth.users(id) on delete cascade,
  week_id     uuid references weeks(id) on delete set null,
  ritual_key  text not null,
  scope       text not null,                      -- '2026-10-10' or '2026-W41'
  started_at  timestamptz,
  ended_at    timestamptz,
  status      text not null default 'active'
              check (status in ('active','completed','skipped','abandoned')),
  updated_at  timestamptz not null default now()
);

create table if not exists run_steps (
  run_id      text not null references runs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  step_id     text not null,
  title       text not null default '',
  status      text not null default 'pending'
              check (status in ('pending','active','completed','skipped')),
  seconds     int  not null default 0,
  segments    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (run_id, step_id)
);

create table if not exists extras (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  day_date    date not null,
  text        text not null,
  minutes     int,
  at          timestamptz not null default now(),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- The 21:00 close-out, so the app shows exactly what #schedule says.
create table if not exists day_summaries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  day_date    date not null,
  body        text not null,
  source      text not null default 'hermes' check (source in ('hermes','app')),
  updated_at  timestamptz not null default now(),
  unique (user_id, day_date)
);

-- ---------------------------------------------------------------- indexes

create index if not exists rituals_week_day_idx on rituals (week_id, day_code, position);
create index if not exists goals_week_idx        on goals (week_id, position);
create index if not exists runs_scope_idx        on runs (user_id, scope);
create index if not exists extras_day_idx        on extras (user_id, day_date);

-- ---------------------------------------------------------------- triggers

do $$
declare t text;
begin
  foreach t in array array['weeks','week_days','goals','rituals','anchors','runs','run_steps','extras','day_summaries']
  loop
    execute format('drop trigger if exists touch_%1$s on %1$s', t);
    execute format('create trigger touch_%1$s before update on %1$s for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS

do $$
declare t text;
begin
  foreach t in array array['weeks','week_days','goals','rituals','anchors','runs','run_steps','extras','day_summaries']
  loop
    execute format('alter table %s enable row level security', t);
    execute format('drop policy if exists own_rows on %s', t);
    execute format('create policy own_rows on %s for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
