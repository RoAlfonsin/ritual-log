# Ritual Log

A single-page **run** of the day and the week, built on the Mini Rituals domain
model. It exists so the day can be logged **at the moment it happens** — on the
phone or the laptop — and shared to `#schedule` in one tap, instead of being
reconstructed afterwards from memory.

Live: https://roalfonsin.github.io/ritual-log/

## Vocabulary (from the Mini Rituals repo)

The tool uses Mini Rituals' own terms, and the product copy is English, as the
repo is:

| Mini Rituals | Here |
|---|---|
| **Ritual** | the day ritual (the locked skeleton) and the week ritual (the "once this week" items) |
| **Step** | one block of the skeleton, or one weekly chore |
| **Timer** | the step's planned duration — it alerts, it never completes the step for you |
| **Run** | one execution of a ritual; the day run is pinned to its date, the week run to its ISO week |
| **Active run** | one at a time per ritual; starting a new day's run abandons the previous unfinished one |
| **Completion** | the record that a step was completed (idempotent — completing twice changes nothing) |
| **Skip** | a completion carrying `skipped`, so history stays honest |
| **Slide to complete** | the gesture that commits a step; **Complete** does the same with no gesture, and a setting turns the track into a tap target |
| **Completion moment** | the bloom + restrained confetti + bell when the last step lands |
| **Run summary** | duration, steps, skips, work time, and the share text |
| **Run history** | the read-only list of past runs (never overwritten) |
| **Sync state** | shown in the header: this device · saving · syncing · synced · not saved |
| **Ritual view** | exactly one presentation per ritual — no checklist/SOP variants |

Design tokens are the Mini Rituals palette (TRD §16.1), both themes, warm paper
neutrals with the terracotta accent. Motion is short and ease-out; the only
springy moment is the completion bloom.

## Files

```
docs/index.html    the app (one view per ritual: Today · Ritual · Summary)
docs/app.js        model, sync, render, slide control, share text
docs/styles.css    Mini Rituals tokens
docs/plan.json     generated: rituals, the week's days, goals, anchors
tools/build_plan.py  regenerates docs/plan.json from Hermes' state files
```

`docs/config.js` (the `#schedule` webhook) is generated in CI from the repo
secret `SCHEDULE_WEBHOOK` and is gitignored — never commit it.

## Where the data lives

The device store is `localStorage` (`ritual-log.v2`): instant, offline, and the
reason a step can be logged on a phone with no signal.

Both devices share **one document in a private gist**
(`ritual-log.json`, id `f5e0ab302e947c02675069113296131f`). That single document
is the whole backend — no server, no database, no accounts:

- Every mutation stamps `ts` on the record it touches.
- Reading merges the shared document into the local store; a step or run with a
  newer `ts` wins, everything else is kept. So a step completed on the phone is
  never undone by a stale laptop screen, and the union of both devices survives.
- Writing reads the document again, merges, and writes it back.
- The plan is cached locally too (`ritual-log.plan.v2`) and refreshed in the
  background, so reads never block on the network.

To connect a device, paste a GitHub token with **`gist`** scope into
*Summary → Shared log → Connect* ([create one](https://github.com/settings/tokens/new?scopes=gist&description=Ritual%20Log)).
The token is kept in that browser's `localStorage` and can be revoked at any
time. Without it the app works fine — it just stays on that device, and the
header says so.

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

Chore labels are copied **verbatim** from the `#life` week file: they are the same
strings the Discord checklist uses, so the two can never drift.

## Deploy

GitHub Actions builds and publishes `docs/` to Pages (`build_type: workflow`).
A push to `main` is enough; the run takes about a minute.
