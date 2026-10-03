#!/usr/bin/env python3
"""Build docs/plan.json for Ritual Log from Hermes' own state files.

Sources (read-only):
  ~/.hermes/state/schedule/COMPOSER.md          the locked day skeleton
  ~/.hermes/state/schedule/weeks/YYYY-Www.md    the week: goals, day map, anchors
  ~/.hermes/state/life/weeks/YYYY-Www.md        the "Once this week" ritual items

Chore labels are copied VERBATIM from the #life week file: they are the same
strings the Discord checklist uses, so the two never drift.
"""
import json, re, sys, datetime as dt
from pathlib import Path

HOME = Path.home()
STATE = HOME / ".hermes/state"
OUT = Path(__file__).resolve().parents[1] / "docs/plan.json"

# Explicit ids/translations for the skeleton rows (COMPOSER.md is English, the
# product copy is Spanish). Fallback: a slug of the source label.
ROWS = {
    "Read (+ coffee at the end)": ("read", "Leer (+ café al final)", None),
    "Cleaning": ("cleaning", "Limpieza", None),
    "Exercise + meditation 1h": ("exercise-meditation", "Ejercicio + meditación", None),
    "Breakfast (cook + eat)": ("breakfast", "Desayuno (cocinar + comer)", None),
    "Shower + grooming": ("shower-grooming", "Ducha + aseo", None),
    "Work A": ("work-a", "Trabajo A", "work"),
    "Cook + dinner (+ dishes)": ("cook-dinner", "Cocinar + cena (+ trastes)", None),
    "Work B": ("work-b", "Trabajo B", "work"),
    "Journaling": ("journaling", "Journaling", None),
    "Rest (games, Netflix, reading)": ("rest", "Descanso (juegos, Netflix, lectura)", None),
    "Lights out": ("lights-out", "Apagar luces", None),
}
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def strip_md(s):
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    return s.strip().strip("*").strip()


def skeleton(composer: Path):
    steps, inside = [], False
    for line in composer.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = line.startswith("## Rodri's day skeleton")
            continue
        if not inside or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) != 2 or cells[0] in ("Block", "") or set(cells[1]) <= set("-: "):
            continue
        label, window = cells
        sid, title, kind = ROWS.get(label, (slug(label), label, None))
        start = end = None
        if "–" in window:
            a, b = [p.strip() for p in window.split("–", 1)]
            start, end = (a or None), (b or None)
        elif window:
            start = window.strip() or None
        step = {"id": sid, "title": title, "start": start, "end": end,
                "minutes": (to_min(end) - to_min(start)) if start and end else None}
        if kind:
            step["kind"] = kind
        steps.append(step)
    return steps


def life_items(path: Path):
    """The 'Once this week' list, verbatim."""
    if not path.exists():
        return []
    out, inside = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = line.lower().startswith("## once this week")
            continue
        if not inside or not line.startswith("- "):
            continue
        raw = line[2:].strip()
        if raw.startswith("~~"):           # struck through: not due this week
            continue
        raw = re.sub(r"^\[[ x]\]\s*", "", raw)
        raw = re.sub(r"\s*—\s*not due.*$", "", raw)
        label = strip_md(raw)
        if label:
            out.append({"id": slug(label), "title": label, "optional": True})
    # de-duplicate ids (the same chore appears 3x with (1/3) suffixes — keep them distinct)
    seen, uniq = {}, []
    for i, s in enumerate(out):
        s["id"] = s["id"] if s["id"] not in seen else f"{s['id']}-{i}"
        seen[s["id"]] = True
        uniq.append(s)
    return uniq


def parse_week(path: Path):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    m = re.search(r"^#\s*Week\s+(\d+)\s*—\s*(\w{3})\s*(\d{1,2})\s*(\w{3})\s*–\s*\w{3}\s*(\d{1,2})\s*(\w{3})\s*(\d{4})", text, re.M)
    if not m:
        sys.exit("plan: cannot read the week header of " + str(path))
    wn, _wd, d1, mo1, _d2, _mo2, yr = m.groups()
    monday = dt.date(int(yr), MONTHS[mo1], int(d1))
    month_end = monday + dt.timedelta(days=6)
    iso = monday.isocalendar()

    sections, cur = [], None
    anchors, daymap, progress = [], [], []
    for line in lines:
        if line.startswith("## "):
            head = line[3:].strip()
            if head == "Anchors":
                cur = "anchors"
            elif head == "Day map":
                cur = "daymap"
            elif head == "Progress":
                cur = "progress"
            else:
                parts = [p.strip() for p in head.split("—", 1)]
                cur = {"name": parts[0], "sub": parts[1] if len(parts) > 1 else ""}
                cur["goal"] = ""
                sections.append(cur)
            continue
        if cur == "anchors" and line.startswith("- "):
            anchors += [a.strip() for a in line[2:].split("·") if a.strip()]
        elif cur == "daymap" and line.startswith("- "):
            daymap.append(line[2:].strip())
        elif cur == "progress" and line.startswith("- "):
            progress.append(line[2:].strip())
        elif isinstance(cur, dict):
            if not cur["goal"] and "**" in line:
                cur["goal"] = strip_md(line)
            if not cur.get("bullet") and line.startswith("- "):
                cur["bullet"] = strip_md(line[2:])

    goals = []
    for s in sections:
        detail, status = s.get("bullet", ""), None
        for p in progress:
            pm = re.match(r"^\*\*(.+?)\s*—\s*(on track|at risk):?\*\*:?\s*(.*)$", p)
            if pm and pm.group(1).strip().lower().split()[0] in s["name"].lower():
                detail, status = strip_md(pm.group(3)) or detail, pm.group(2)
                break
        g = {"project": s["name"], "headline": s["sub"], "detail": detail}
        if status:
            g["status"] = "at_risk" if status == "at risk" else "on_track"
        goals.append(g)

    # day map → per-date work titles; anchors → per-date fragments that name a weekday
    days = {}
    for i, wd in enumerate(WEEKDAYS):
        days[(monday + dt.timedelta(days=i)).isoformat()] = {"work_a": None, "work_b": None, "anchors": []}
    for row in daymap:
        dm = re.match(r"^(\w{3})\s+(\d{1,2})", row)
        if not dm or dm.group(1) not in WEEKDAYS:
            continue
        d = monday + dt.timedelta(days=WEEKDAYS.index(dm.group(1)))
        if d.day != int(dm.group(2)):
            continue
        body = row[dm.end():].lstrip(":").strip()
        for part in re.split(r"\s·\s", body):
            pm = re.match(r"^([AB])\s+(.*)$", part.strip())
            if pm:
                val = strip_md(pm.group(2)).replace("✅", "").strip()
                if val:
                    days[d.isoformat()]["work_" + pm.group(1).lower()] = val
    for frag in anchors:
        fm = re.match(r"^(\w{3})\b\s*(\d{1,2})?", frag)
        if not fm or fm.group(1) not in WEEKDAYS:
            continue
        d = monday + dt.timedelta(days=WEEKDAYS.index(fm.group(1)))
        if fm.group(2):
            # "Mon 5 Oct 18:00 Mauricio" belongs to NEXT week — only accept a
            # day number that matches this week's weekday.
            if d.day != int(fm.group(2)):
                continue
            mm = re.match(r"^\w{3}\s+\d{1,2}\s+(\w{3})", frag)
            if mm and MONTHS.get(mm.group(1)) and MONTHS[mm.group(1)] != d.month:
                continue
        days[d.isoformat()]["anchors"].append(frag)

    return {"iso": f"{iso[0]}-W{iso[1]:02d}", "label": f"Semana {wn}",
            "start": monday.isoformat(), "end": month_end.isoformat(),
            "reserve_saturday": "Reserve Saturday: on" in text}, days, goals, anchors


def main():
    week_no = None
    if len(sys.argv) > 1:
        week_no = int(sys.argv[1])
    today = dt.date.today()
    iso = today.isocalendar()
    wk = f"{iso[0]}-W{week_no:02d}" if week_no else f"{iso[0]}-W{iso[1]:02d}"
    week_file = STATE / f"schedule/weeks/{wk}.md"
    if not week_file.exists():
        cands = sorted((STATE / "schedule/weeks").glob("*.md"))
        if not cands:
            sys.exit("plan: no week file in ~/.hermes/state/schedule/weeks")
        week_file = cands[-1]
        wk = week_file.stem
    life_file = STATE / f"life/weeks/{wk}.md"

    wk_meta, days, goals, anchors = parse_week(week_file)
    plan = {
        "updated": dt.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "source": {"week_file": str(week_file), "life_file": str(life_file) if life_file.exists() else None},
        "week": wk_meta,
        "rituals": {
            "day": {"title": "Día", "order_mode": "sequential", "steps": skeleton(STATE / "schedule/COMPOSER.md")},
            "week": {"title": "Semana", "order_mode": "free", "steps": life_items(life_file)},
        },
        "days": days,
        "goals": goals,
        "anchors": anchors,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"plan.json → {OUT}")
    print(f"  {plan['week']['iso']} · day {len(plan['rituals']['day']['steps'])} pasos · "
          f"semana {len(plan['rituals']['week']['steps'])} pasos · {len(goals)} objetivos · "
          f"días con trabajo: {sum(1 for d in days.values() if d['work_a'] or d['work_b'])}")


if __name__ == "__main__":
    main()
