# Ritual Log on Supabase — the shared week

Decided 2026-10-04 (Rodri's call). The gist stops being the store; Supabase becomes
the single source for **the week** (goals, days, rituals, anchors) **and the runs**,
so the app he edits and the plan Hermes composes are the same rows. Schema:
`db/schema.sql` in this repo — paste it into the project's SQL editor once.

This file lives at the repo root on purpose: Pages publishes `docs/` only, so nothing
here is ever served. Never put a key in `docs/`.

## Why the shape it has

- **The week is editable from both sides.** He edits rituals, goals, days and anchors
  in the app; Hermes composes and corrects. Last write wins **per row** on
  `updated_at` (a trigger keeps it honest), `source` records who owns a row, and
  Hermes never overwrites a row it does not own.
- **Deletes are tombstones** (`deleted = true`). Without them the next compose
  resurrects a ritual he removed.
- **`ritual_key`** (`mon-read`, `fri-work-a`) is the stable identity across weeks;
  runs already key off it as `<ritual_key>:<scope>`, so the existing gist document
  imports idempotently.
- **`day_summaries`** carries Hermes' close-out into the app, so the summary he reads
  on the phone is the one posted to #schedule.
- **Offline stays.** The app keeps its localStorage copy and its outbox: Supabase is
  the sync target, not a hard dependency. A phone in a dead spot still logs runs.

## Auth

Supabase Auth, **magic link to his email** — one account, no password to store, no
secret in the bundle except the anon key (public by design, RLS does the work).
Redirect URL: `https://roalfonsin.github.io/ritual-log/`.
The app keeps its existing session in `localStorage` and refreshes it on boot.

## Phases

1. **Project + schema** — he creates the Supabase project; the SQL above is applied;
   Hermes' service key lands in `~/.hermes/secrets/ritual-log-supabase.env` (0600,
   never printed, never in this repo).
2. **Hermes side** (`~/.hermes/scripts/ritual_log_supabase.py`) — push the week from
   the files it already keeps (weeks, goals, days, rituals, anchors) and pull his
   edits back, so the pinned plan and the app agree. Runs as part of the composer, not
   a poller.
3. **App side** — import the week from Supabase into the Plan/Week tabs, extend the
   editor to every ritual (title, day, start/end, minutes, delete, add), sign in with
   the magic link, and keep the outbox for offline.
4. **Import + cut over** — the 9 runs and the "Junta con Mauricio" extra from the gist
   move into `runs`/`extras` (the gist stays untouched as a backup), then the gist
   stops being written.

## Hermes' half, concretely

- `ritual_log_supabase.py --push-week 2026-W41` reads
  `~/.hermes/state/schedule/weeks/2026-W41.md` and the #life file, upserts the rows,
  and prints a one-line diff (`+2 rituals, 1 goal edited by him`).
- `--pull-edits 2026-W41` applies app-side changes back into the week file before the
  06:15 plan is composed, so Monday's day plan reflects what he changed on Sunday.
- Both are plain REST calls with `urllib` — no CLI, no npm, nothing installed.

## Known costs

- Free tier is plenty (this is kilobytes).
- The composer's day-plan job is `no_agent` and must stay instant: the pull runs
  **before** it in the same 05:00–06:00 window, and a failed pull leaves the files
  exactly as they are.
