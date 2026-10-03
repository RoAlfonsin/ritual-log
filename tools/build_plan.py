#!/usr/bin/env python3
"""Build docs/plan.json for Ritual Log from Hermes' own state files.

Sources (read-only):
  ~/.hermes/state/schedule/weeks/YYYY-Www.md    the week: goals, day map, anchors
  ~/.hermes/state/life/weeks/YYYY-Www.md        the "Once this week" ritual items
  ~/.hermes/scripts/day_plan.py                 THE authority for what a day holds

The rituals are not derived from the spec document: they come from `day_plan.py`'s
`day_rows()`, the same function that prints the day plan posted to #schedule every
morning. So the app can never show a block the day does not have (Saturday has no
cleaning and no work) or a chore that is not in that day's row, and the labels are
the ones Rodri reads in the channel every morning.
"""
import json, re, sys, datetime as dt, importlib.util
from pathlib import Path

HOME = Path.home()
STATE = HOME / ".hermes/state"
OUT = Path(__file__).resolve().parents[1] / "docs/plan.json"
SCRIPTS = HOME / ".hermes/scripts"


def load_day_plan():
    """day_plan.py owns the day's shape: the skeleton, the chores inside each block
    (CHORES/GROOMING/HANG_OUT/REST_EXTRA), the day map and the menus. Import it
    instead of re-typing any of it, so the two can never drift."""
    spec = importlib.util.spec_from_file_location("day_plan_for_plan", SCRIPTS / "day_plan.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DAY_PLAN = load_day_plan()

# day_plan's skeleton label -> (id, English title, kind). Titles stay in the
# product's language (English, as the Mini Rituals repo is); the structure around
# them is day_plan's.
BLOCK = {
    "Read · coffee at the end": ("read", "Read (+ coffee at the end)", None),
    "Cleaning": ("cleaning", "Cleaning", None),
    "Exercise + meditation 1h": ("exercise-meditation", "Exercise + meditation", None),
    "Breakfast": ("breakfast", "Breakfast (cook + eat)", None),
    "Shower + grooming": ("shower-grooming", "Shower + grooming", None),
    "Work A": ("work-a", "Work A", "work"),
    "Cook + dinner": ("cook-dinner", "Cook + dinner", None),
    "Work B": ("work-b", "Work B", "work"),
    "Journaling": ("journaling", "Journaling", None),
    "Rest": ("rest", "Rest (games, Netflix, reading)", None),
    "Lights out": ("lights-out", "Lights out", None),
}

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat"]
DAY_LABEL = {"mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat"}
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

    return {"iso": f"{iso[0]}-W{iso[1]:02d}", "label": f"Week {wn}",
            "start": monday.isoformat(), "end": month_end.isoformat(),
            "reserve_saturday": "Reserve Saturday: on" in text}, days, goals, anchors


def cap(s):
    return (s[:1].upper() + s[1:]) if s else s


def build_rituals(monday: dt.date, week_items: list):
    """The week's fund of mini rituals, straight from day_plan's rows.

    A block that holds activities is dissolved into them (there is no "Fri Cleaning",
    there is vacuum / laundry in / litter scoop); a block that is a single activity
    stays whole; a work block is titled with that day's day-map item. Ticks are
    ignored on purpose: this is the week's shape, not what is left of it."""
    out = []
    for i, code in enumerate(DAY_CODES):                 # Mon–Sat; Sunday is free
        date = monday + dt.timedelta(days=i)
        order = 0
        for row in DAY_PLAN.day_rows(date, ticks=False):
            bid, title, kind = BLOCK.get(row["label"], (slug(row["label"]), row["label"], None))
            notes = [it["label"] for it in row["items"] if it["kind"] == "note"]
            activities = [it["label"] for it in row["items"] if it["kind"] == "activity"]
            work = next((it["label"] for it in row["items"] if it["kind"] == "work"), None)
            if work:
                work = strip_md(re.sub(r"[✅✔]+", "", work)).strip()

            if activities:
                for label in activities:                 # a chore inside the block
                    order += 1
                    t = f"{DAY_LABEL[code]} {cap(label)}"
                    out.append({"id": f"{code}-{slug(label)}", "day": code, "title": t, "order": order,
                                "block": title, "block_window": row["span"],
                                "start": None, "end": None, "minutes": None,
                                "steps": [{"id": "main", "title": t}]})
                continue                                 # the container is not a ritual itself

            order += 1
            t = f"{DAY_LABEL[code]} {title}" + (f" · {work}" if work else "")
            r = {"id": f"{code}-{bid}", "day": code, "title": t, "order": order,
                 "start": row["start"], "end": row["end"],
                 "minutes": (to_min(row["end"]) - to_min(row["start"])) if row["start"] and row["end"] else None,
                 "steps": [{"id": "main", "title": t}]}
            if notes:
                r["note"] = notes[0]
            if kind:
                r["kind"] = kind
            out.append(r)
    for it in week_items:                                # no day: once this week, any day
        out.append({"id": "weekly-" + it["id"], "day": None, "title": it["title"], "order": 0,
                    "optional": True, "minutes": None, "start": None, "end": None,
                    "steps": [{"id": "main", "title": it["title"]}]})
    return out


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
    monday = dt.date.fromisoformat(wk_meta["start"])
    week_items = life_items(life_file)
    rituals = build_rituals(monday, week_items)
    plan = {
        "updated": dt.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "source": {"week_file": str(week_file), "life_file": str(life_file) if life_file.exists() else None},
        "week": wk_meta,
        "rituals": rituals,
        "days": days,
        "goals": goals,
        "anchors": anchors,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    per_day = {}
    for r in rituals:
        if r["day"]:
            per_day[r["day"]] = per_day.get(r["day"], 0) + 1
    print(f"plan.json → {OUT}")
    print(f"  {plan['week']['iso']} · {len(rituals)} mini rituals · "
          + " · ".join(f"{DAY_LABEL[d]} {per_day.get(d, 0)}" for d in DAY_CODES)
          + f" · {sum(1 for r in rituals if not r['day'])} any-day · {len(goals)} goals")


if __name__ == "__main__":
    main()
