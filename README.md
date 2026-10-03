# Ritual Log

The week's **mini rituals**, logged **at the moment they happen** — on the phone
or the laptop — and reported to `#schedule` one line at a time instead of being
reconstructed afterwards from memory.

Live: https://roalfonsin.github.io/ritual-log/

## The model

One fund of rituals, one day at a time:

- Every ritual is a concrete **per-day instance**: *Mon Read*, *Fri Read*,
  *Fri Work A · iCare — merge #56, then 1.11*.
- A block that holds activities is **dissolved into those activities**: there is no
  *Fri Cleaning* ritual — there is *Fri Sweep + vacuum (3/3)*, *Fri Laundry 3 — put
  in* and *Fri Cat litter — scoop*, each with its own run and its own line in the log.
  The same happens inside *Shower + grooming* (the day's shave/nails), *Exercise +
  meditation* (hanging the wash out), *Cook + dinner* (dishes) and *Rest* (arranging
  the wash).
- What a day holds is **not** decided here: the app reads `day_plan.py`'s `day_rows()`,
  the same function that prints the plan posted to #schedule each morning. So a block
  the day does not have does not exist in the app either — Saturday has no cleaning
  and no work block, and shows eight rituals, exactly like its posted plan.
- **Week** is the whole fund — all six days plus the *any day this week* items.
- **Today** is only the slice that belongs to the current weekday.
- The day is **not** a ritual: nothing wraps the day. A day is a list of small
  rituals, each with its own run, its own timer and its own completion.
- Each ritual carries a single **step** today. The step list is data, so a ritual
  can grow into a real sequence without changing the app.

## Vocabulary (from the Mini Rituals repo)

| Mini Rituals | Here |
|---|---|
| **Ritual** | one per-day instance (*Mon Read*), or one *any day this week* item |
| **Step** | the ritual's single step for now |
| **Timer** | the ritual's planned duration — it alerts, it never completes anything for you |
| **Run** | one execution of one ritual, pinned to that ritual's day (or to the ISO week for the *any day* items) |
| **Completion** | the record that a step was completed (idempotent — completing twice changes nothing) |
| **Skip** | a completion carrying `skipped`, so history stays honest |
| **Slide to complete** | the gesture that commits a step; **Complete** does the same with no gesture |
| **Completion moment** | a small check bloom for one ritual; the bell and confetti only when the whole day is done |
| **Run history** | the read-only list of completions (never overwritten) |
| **Sync state** | in the header: this device · saving · syncing · synced · not saved, plus how many lines are still to send |
| **Ritual view** | exactly one presentation per ritual — no checklist/SOP variants |

Design tokens are the Mini Rituals palette (TRD §16.1), both themes: warm paper
neutrals with the terracotta accent.

## What reaches #schedule

Every finished ritual posts one line, the moment it happens:

```
✅ Fri Read (+ coffee at the end) · 06:32–07:19 · 47m (plan 50m)
✅ Sat Read (+ coffee at the end) · 05:30–07:12 + 07:45–08:01 · 48m active (plan 50m)
↷ Fri Journaling — skipped
```

A step's time is stored as **segments**, so a pause and a resume read honestly: the
windows it was actually worked in, and the active total — not one span that swallows
the hours it sat paused.

Failed or offline sends stay in a device-local **outbox** and retry on the next
tick, on `online`, and on focus, so a ritual finished in a dead spot still lands.
The header shows the queue. *Summary → The day's log* still offers the whole day
in one message. The per-completion posts can be switched off in Settings; they
need no token.

## Files

```
docs/index.html      the app (Today · Week · Ritual · Summary)
docs/app.js          model, sync, outbox, render, slide control, log text
docs/styles.css      Mini Rituals tokens
docs/plan.json       generated: the rituals, the week's days, goals, anchors
tools/build_plan.py  regenerates docs/plan.json from Hermes' state files
```

`docs/config.js` (the `#schedule` webhook) is generated in CI from the repo
secret `SCHEDULE_WEBHOOK` and is gitignored — never commit it.

## Where the data lives

The device store is `localStorage` (`ritual-log.v3`): instant, offline, and the
reason a ritual can be logged on a phone with no signal.

Both devices share **one document in a private gist**
(`ritual-log.json`, id `f5e0ab302e947c02675069113296131f`). That single document
is the whole backend — no server, no database, no accounts:

- Every mutation stamps `ts` on the record it touches.
- Reading merges the shared document into the local store; the newer `ts` wins per
  run and per step, everything else is kept. A ritual completed on the phone is
  never undone by a stale laptop screen, and the union of both devices survives.
- Writing reads the document again, merges, and writes it back.
- The outbox is **not** synced: it is delivery state, not history.
- The plan is cached locally too (`ritual-log.plan.v3`) and refreshed in the
  background, so reads never block on the network.

To connect a device, paste a GitHub token with **`gist`** scope into
*Summary → Shared log → Connect* ([create one](https://github.com/settings/tokens/new?scopes=gist&description=Ritual%20Log)).
The token stays in that browser's `localStorage` and can be revoked at any time.
Without it the app works — it just stays on that device, and the header says so.

If this ever needs more than one document (real multi-user accounts, per-run
conflict copies, history of every edit), Supabase is the next step. For one
person logging from two devices, a single merged document is enough — and it
needs nothing to run.

## Updating the plan

`plan.json` is derived, never hand-edited:

```bash
python3 tools/build_plan.py          # current ISO week
python3 tools/build_plan.py 41       # a specific week
```

It reads, read-only:

- `~/.hermes/state/schedule/COMPOSER.md` → the day skeleton (the locked times)
- `~/.hermes/state/schedule/weeks/YYYY-Www.md` → the week's goals, day map, anchors
- `~/.hermes/state/life/weeks/YYYY-Www.md` → the "Once this week" items

Each of the 11 skeleton blocks becomes a ritual for **every** weekday (Mon–Sat),
titled with its day, and the work blocks take the day map's item text. Blocks that
only contain chores are dissolved into them: the chore list and its per-weekday
placement come from `~/.hermes/scripts/day_plan.py`'s
`CHORES` / `GROOMING` / `HANG_OUT` / `REST_EXTRA` tables, **imported rather than
re-typed**, so the labels are the same strings the #life checklist uses and can
never drift.

## Deploy

GitHub Actions builds and publishes `docs/` to Pages (`build_type: workflow`).
A push to `main` is enough; the run takes about a minute.
