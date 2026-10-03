# Ritual Log

A single-page, offline-first **run** of Rodri's day and week, built on the Mini
Rituals domain model. It exists so the day can be logged **at the moment it
happens**, from the phone, and shared to `#schedule` in one tap — instead of
reconstructing the day afterwards from memory.

Live: https://roalfonsin.github.io/ritual-log/

## Vocabulary (from the Mini Rituals repo)

The tool uses Mini Rituals' own terms, so the two never drift:

| Mini Rituals | Here |
|---|---|
| **Ritual** | the day ritual (the locked skeleton) and the week ritual (the "once this week" items) |
| **Step** | one block of the skeleton, or one weekly chore |
| **Timer** | the step's planned duration — it alerts, it never completes the step for you |
| **Run** | one execution of a ritual; the day run is pinned to its date, the week run to its ISO week |
| **Active run** | one at a time per ritual; starting a new day's run abandons the previous unfinished one |
| **Completion** | the record that a step was completed (idempotent — completing twice changes nothing) |
| **Skip** | a completion with `skipped`, so history stays honest |
| **Slide to complete** | the gesture that commits a step, with an always-available alternative control and a tap-mode setting |
| **Completion moment** | the bloom + restrained confetti + bell when the last step lands |
| **Run summary** | duration, steps, skips, work time, and the share text |
| **Run history** | the read-only list of past runs (never overwritten) |
| **Local-first** | the device's own store is the source of truth; the plan is served from cache and refreshed in the background |
| **Ritual view** | exactly one presentation per ritual — no checklist/SOP variants |

Design tokens are the Mini Rituals palette (TRD §16.1), both themes, warm paper
neutrals with the terracotta accent. Motion is short and ease-out; the only
springy moment is the completion bloom.

## Files

```
docs/index.html    the app (one view per ritual: Hoy · Ritual · Resumen)
docs/app.js        model + render + slide control + share text
docs/styles.css    Mini Rituals tokens
docs/plan.json     generated: rituals, the week's days, goals, anchors
tools/build_plan.py  regenerates docs/plan.json from Hermes' state files
```

`docs/config.js` (the `#schedule` webhook) is generated in CI from the repo
secret `SCHEDULE_WEBHOOK` and is gitignored — never commit it.

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

## Data

Everything the app records lives in this browser's `localStorage`
(`ritual-log.v1`); `plan.json` is cached there too (`ritual-log.plan.v1`). Backups
are the JSON in *Resumen → Respaldo*, which also restores.

## Deploy

GitHub Actions builds and publishes `docs/` to Pages (`build_type: workflow`).
A push to `main` is enough; the run takes about a minute.
