#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Regenerates the SYNTHETIC fixtures for tests/quicksight-ep-compose.test.js.

Every name, client and number here is invented; no real employee data.

  workbook.json        the synthetic workbook exactly as build_data.py's
                       pandas.read_excel(sheet_name=None, dtype=object) sees it
  golden-d.json        the D object build_data.py writes for that workbook
                       (the JSON between `const D=` and `;`)
  numeric-golden.json  pandas/numpy/Python results for the summation and
                       rounding helpers, on generated vectors

Usage (needs pandas + openpyxl; the MIS build_data.py is not in this repo):
  python tests/fixtures/qs-ep/make_fixtures.py /path/to/build_data.py

build_data.py is run twice under different PYTHONHASHSEEDs and must produce
identical output: its TimeChamp name lookup iterates a set, so a fixture that
depended on set order would be a flaky golden.
"""
import datetime as dt
import json
import math
import os
import random
import subprocess
import sys
import tempfile

import numpy as np
import openpyxl
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
rng = random.Random(20260916)
D = dt.datetime


def day(s, h=10, m=0):
    y, mo, d = map(int, s.split("-"))
    return D(y, mo, d, h, m)


def days(a, b):
    out, cur, end = [], dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    while cur <= end:
        out.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return out


NAN = None  # a blank cell

# ── emp detail ────────────────────────────────────────────────────────────────
# Columns deliberately out of month order (September before Aug), plus an extra.
EMP_HEAD = ["EMP ID", "EMPLOYE NAME", "CRM CURRENT NAME", "Row Labels", "vertical",
            "team Name september", "Team Name Aug", "Notes"]
EMP = [
    ["E900001", "Tara Quill", "Tara Quill", "Tara", "Furniture", "Alpha", "Alpha", "lead"],
    ["E900002", "Bram Oakes", "Bram O", "Bram", "Sports", "Bravo", "Bravo", NAN],
    # SPOC whose team changes Charlie -> Alpha (legacy teamSize 0), vertical 0 -> None
    ["E900003", "Cyra Vale", "Cyra", NAN, 0, "Alpha", "Charlie", NAN],
    # member whose team changes Alpha -> Bravo
    ["E900004", "Dax Morrow", "Dax", "Daxy", NAN, "Bravo", "Alpha", NAN],
    ["E900005", "Elin Frost", "Elin", "Elin F", "Retail Maintenance", "Bravo", "Bravo", NAN],
    # member of a team with no primary SPOC
    ["E900006", "Fenn Hale", "Fenn", NAN, "Sports", "Delta", "Delta", NAN],
    # blank CRM CURRENT NAME -> row skipped
    ["E900007", "Gil Stone", NAN, "Gil", "Furniture", "Alpha", "Alpha", NAN],
    # duplicate CRM name 'Elin': last row wins, teamMembers repeats it
    ["E900008", "Elin Brook", "Elin", "EB", "Furniture", "Alpha", "Bravo", NAN],
    # SPOC with orders but no target, blank September team
    # its Row Label 'Bram' is already claimed by row 2: the FIRST claim wins
    ["E900009", "Hugo Reed", "Hugo", "Bram", "Furniture", NAN, "Alpha", NAN],
    # SPOC with a target only, lower-case CRM name
    ["E900010", "Ivo Lark", "ivo lark", "Ivo", "Relocation", "Echo", "Echo", NAN],
    # no EMP ID, no team, no vertical
    [NAN, "Juno Pike", "Juno", NAN, NAN, NAN, NAN, NAN],
    # two target-less SPOCs in one team: the lead is picked by name on the tie
    ["E900012", "Lex Rowe", "Lex", NAN, "Sports", "Foxtrot", "Foxtrot", NAN],
    ["E900013", "Kai Moss", "Kai", NAN, "Sports", "Foxtrot", "Foxtrot", NAN],
    ["E900014", "Mo Finch", "Mo", NAN, NAN, "Foxtrot", "Foxtrot", NAN],
]

# ── target lists ──────────────────────────────────────────────────────────────
TL_HEAD = ["Primary spoc", "Target Amount", "Daily Target", "Vertical", "month"]
TL = [
    ["Tara Quill", 1300000, 50000.0, "Furniture", "August"],
    ["tara ", 1560000, 60000.0, "Furniture", "September"],          # Row Label alias
    ["Bram Oakes", 520000.5, 20000.01923076923, "Sports", "August"],  # EMPLOYE NAME alias
    ["Bram O", 650000, 25000.0, "Sports", "September"],
    ["Cyra", 260000, 10000.0, NAN, "august"],
    ["Cyra", 100, 5, NAN, "Sept"],                                    # bad month: skipped
    ["Ivo", 780000.25, 30000.009615384617, "Relocation", "September"],
    ["Zed Unlisted", 999999, 38461.5, "Furniture", "August"],         # not in emp detail
    [NAN, 5000, 192.3, NAN, "August"],
    ["Tara Quill", 13000, 500.0, "Furniture", "August"],              # duplicate month
]
ST_HEAD = ["Name", "Total Target", "month"]
ST = [
    ["Dax Morrow", 390000, "August"],
    ["Daxy", 416000.5, "September"],
    ["Elin", 260000, "September"],
    ["Vale Outsider", 100000, "August"],
    [NAN, 5000, "August"],
    ["tara", 520000.5, "september"],
    ["Bram", 200000, "August"],                                     # alias claimed by Bram O first
    ["Cyra", 130000, "October"],
]

CLIENTS = ["Acme Furnishings", "Globex Sports", "Initech Retail", "Umbrella Moves"]
ZMS = ["ZM North", "ZM South"]
CITIES = [("State One", "Metro City"), ("State One", "Gotham"), ("State Two", "Star City")]
TXS = [("Tech Alpha ", 11099), ("Tech Alpha", 11099), ("Tech Beta", 8388), ("Tech Gamma", "4417")]
REASONS = [("Technician", "Part pending"), ("Customer", "Not reachable"), ("Customer", "Reschedule"), (NAN, NAN)]
VERTICALS = {"Tara Quill": ["Furniture"], "Bram O": ["Sports", "Retail Maintenance"], "Bram Oakes": ["Sports"],
             "Cyra": ["Furniture"], "Hugo": ["Furniture"], "Outside Spoc": ["Easyfix", "Sports"], NAN: ["Furniture"],
             "Kai": ["Sports"], "Lex": ["Sports"]}

# ── Open order ────────────────────────────────────────────────────────────────
OP_HEAD = ["No.", "Job Id", "Vertical Name", "State", "City", "Client", "Aging", "Pending Due To",
           "Pending Reason", "Zonal Manager", "Current TX Name", "Current TX Id", "Primary SPOC", "Job Status"]
OP = []
open_spocs = ["Tara Quill"] * 14 + ["Bram O"] * 12 + ["Cyra"] * 5 + ["Hugo"] * 3 + ["Outside Spoc"] * 3
rng.shuffle(open_spocs)
agings = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 30]
for i, sp in enumerate(open_spocs):
    state, city = rng.choice(CITIES)
    due, why = rng.choice(REASONS)
    tx, txid = rng.choice(TXS + [(NAN, NAN)])
    OP.append([i + 1, 540000 + i, rng.choice(VERTICALS[sp]), state, city, rng.choice(CLIENTS), rng.choice(agings), due, why,
               rng.choice(ZMS), tx, txid if not isinstance(txid, int) else str(txid), sp, "Scheduled"])
# edge rows, each pinned to a SPOC so it reaches an employee block
for k, sp in enumerate(["Tara Quill", "Bram O", "Tara Quill", "Cyra", "Tara Quill", "Bram O", "Tara Quill"]):
    OP[k][12] = sp
OP[0][3], OP[0][4] = NAN, NAN            # blank state/city -> em dash, dropped from cityWise
OP[1][3] = "   "                          # whitespace-only state -> ''
OP[2][6] = 2.5                            # non-integral aging
OP[3][6] = NAN                            # blank aging -> 0
OP[4][9] = NAN                            # blank zonal manager -> Unassigned
OP[5][10], OP[5][11] = NAN, 8388          # no TX name but an id (unassigned + txRow)
OP[6][10] = "   "                         # whitespace TX name: kept as-is, not unassigned
OP.append([len(OP) + 1, 549000, "Furniture", "State One", "Gotham", "Acme Furnishings", 4, NAN, NAN, "ZM South",
           "Tech Beta", 8388, NAN, "Scheduled"])  # blank Primary SPOC: zmBreakdown only
for k, sp in enumerate(["Lex", "Kai", "Lex", "Kai", "Lex"]):  # Foxtrot's two target-less SPOCs
    OP.append([len(OP) + 1, 548000 + k, "Sports", "State Two", "Star City", "Globex Sports", k * 3, NAN, NAN,
               "ZM South", "Tech Gamma", "4417", sp, "Scheduled"])
# Aging 0.0625 and 0 in one client and city: avg_age 0.03125 is an exact tie at 4 dp (half-even -> 0.0312)
OP.append([len(OP) + 1, 549001, "Furniture", "State Two", "Tie City", "Tie Client", 0.0625, NAN, NAN, "ZM North",
           "Tech Beta", 8388, "Tara Quill", "Scheduled"])
OP.append([len(OP) + 1, 549002, "Furniture", "State Two", "Tie City", "Tie Client", 0, NAN, NAN, "ZM North",
           "Tech Beta", 8388, "Tara Quill", "Scheduled"])

# ── Close order ───────────────────────────────────────────────────────────────
CL_HEAD = ["No.", "Job Id", "Primary SPOC", "Total Charge", " Margin(%) ", "Audit & Checkout Date", "Client",
           "tat status", "SDA Status", "Zonal Manager", "Vertical Name", "Current TX Name", "Current TX Id",
           "A & CO by", "month"]
CL = []
closed_spocs = (["Tara Quill"] * 150 + ["Bram Oakes"] * 25 + ["Bram O"] * 25 + ["Cyra"] * 20 + ["Hugo"] * 5
                + ["Outside Spoc"] * 10 + [NAN] * 3)
rng.shuffle(closed_spocs)
closed_days = days("2026-08-24", "2026-09-06")
checkers = ["Dax Morrow", "daxy", "Elin", "Tara Quill", "Unknown Checker", NAN, "Juno", "Fenn"]
for i, sp in enumerate(closed_spocs):
    tx, txid = rng.choice(TXS)
    vert = rng.choice(VERTICALS.get(sp, ["Sports"]))
    CL.append([i + 1, 530000 + i, sp, round(rng.uniform(199, 4999), 2), round(rng.uniform(-5, 45), 6),
               day(rng.choice(closed_days), rng.randint(8, 22), rng.randint(0, 59)), rng.choice(CLIENTS),
               rng.choice([0, 1, 1, 1]), rng.choice([0, 1, 1]), rng.choice(ZMS), vert, tx, txid,
               rng.choice(checkers), "Aug"])
CL[0][3] = NAN                            # blank charge -> 0
CL[1][4] = NAN                            # blank margin -> skipped by the mean
CL[2][5] = NAN                            # blank checkout date -> counted, not dated
CL[3][7], CL[3][8] = NAN, NAN             # blank TAT / SDA
CL[4][9] = NAN                            # blank zonal manager
CL[5][12] = "8388.0"                      # id as float text
CL[6][12] = NAN                           # no TX id -> not a txRow
CL[7][3] = "1,234"                        # unparseable charge -> 0
CL[8][5] = "2026-08-30 10:00:00"          # date as text
CL[9][3] = 1000                           # integral charge
for k in range(10, 14):                   # one client whose TAT is always blank
    CL[k][6], CL[k][7] = "Solo Client", NAN

# ── time champ / crm / ivr ────────────────────────────────────────────────────
TC_HEAD = ["Employee Id", "Employee Name", "Team Name", "Department Name", "Working Hours", "Productive Hours",
           "Away Hours", "Date"]
TC = []
def hours():
    w = round(rng.uniform(5, 10), 2)
    return w, round(rng.uniform(4, min(w, 9.5)), 2), round(rng.uniform(0, 2), 2)
for d in days("2026-08-23", "2026-09-05"):
    for emp_id, name in [("E900001", "Tara Quill"), ("E900002", "Bram Oakes"), ("E999999", "CYRA"),
                         ("E900004", "Dax M"), ("T-77", "Elin Brook" if d < "2026-08-30" else "E. Brook"),
                         ("T-88", "F Hale"), ("E900010", "Ivo Lark")]:
        if rng.random() < 0.15:
            continue
        w, p, a = hours()
        TC.append([emp_id, name, "T", "Ops", w, p, a, day(d, 0, 0)])
TC.append(["E900001", "Tara Quill", "T", "Ops", 9, 7.5, 1, day("2026-08-25", 0, 0)])    # duplicate name+date
TC.append(["E900001", "Tara Quill", "T", "Ops", 8, 7, 0.5, day("2026-08-25", 0, 0)])
TC.append(["T-88", "Fenn Hale", "T", "Ops", 8, 8, 0, NAN])                              # undated: id alias only
TC.append(["E900010", "Ivo Lark", "T", "Ops", NAN, 6.99, NAN, day("2026-08-26", 0, 0)])
TC.append(["E900002", NAN, "T", "Ops", 8, 8, 0, day("2026-08-27", 0, 0)])

CR_HEAD = ["Employee", "Booked", "Scheduled", "Audit", "Closed", "Revenue", "Cancelled", "employee id", "Date"]
CR = []
for d in days("2026-08-24", "2026-09-07"):
    for emp_id in ["E900001", "E900002", "E900003", "E900004", "E900008", 0]:
        if rng.random() < 0.2:
            continue
        CR.append(["x", rng.randint(0, 9), rng.randint(0, 5), rng.randint(0, 3), rng.randint(0, 6), 0,
                   rng.randint(0, 2), emp_id, day(d, 0, 0)])
CR.append(["x", 2, 1, 1, 1, 0, 1, "E900001", day("2026-08-24", 0, 0)])      # summed with the day's row
CR.append(["x", 1, NAN, 0, 0, 0, 0, NAN, day("2026-08-28", 0, 0)])          # blank id -> Juno (blank EMP ID)

IV_HEAD = ["Sl.No ", " Agent Name ", " Agent Number ", " Total Incoming Calls ", " Total Outgoing Calls ",
           " Total Missed Calls ", " Avg Handling Time ", "Date"]
IV = []
for d in days("2026-08-25", "2026-09-04"):
    for agent in [" Tara Quill ", "BRAM O", "Bram Oakes", " IVR", "cyra"]:
        if rng.random() < 0.2:
            continue
        IV.append([1, agent, "999", rng.randint(0, 40), rng.randint(0, 60), rng.randint(0, 10),
                   round(rng.uniform(0, 300), 2), day(d, 0, 0)])
IV.append([2, " Tara Quill ", "999", 5, 5, 1, 120.5, day("2026-08-26", 0, 0)])   # duplicate: summed / averaged
IV.append([3, " Tara Quill ", "999", 0, 0, 0, 99.25, day("2026-08-26", 0, 0)])
IV.append([4, "cyra", "999", 0, 0, 0, 0, day("2026-09-01", 0, 0)])


def write_xlsx(path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, head, rows in [("Open order", OP_HEAD, OP), ("Close order", CL_HEAD, CL),
                             ("target list", TL_HEAD, TL), ("emp detail", EMP_HEAD, EMP),
                             ("Secondary spoc target list", ST_HEAD, ST), ("time champ data", TC_HEAD, TC),
                             ("crm data", CR_HEAD, CR), ("ivr data record", IV_HEAD, IV),
                             ("Notes", ["anything"], [["ignored sheet"]])]:
        ws = wb.create_sheet(name)
        ws.append(head)
        for r in rows:
            ws.append(r)
    wb.save(path)


def cell(v):
    if v is None:
        return None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        v = float(v)
        if math.isnan(v):
            return None
        if math.isinf(v):
            return {"$float": "inf" if v > 0 else "-inf"}
        return {"$float": v} if v == int(v) else v
    if v is pd.NaT:
        return None
    if isinstance(v, (dt.datetime, pd.Timestamp, dt.date)):
        return {"$dt": str(v)}
    if isinstance(v, dt.time):
        return {"$time": str(v)}
    if isinstance(v, str):
        return v
    raise TypeError("unsupported cell %r" % (v,))


def workbook_json(path):
    raw = pd.read_excel(path, sheet_name=None, dtype=object)
    return [{"name": n, "columns": [str(c) for c in df.columns],
             "rows": [[cell(v) for v in row] for row in df.itertuples(index=False, name=None)]}
            for n, df in raw.items()]


def dump_workbook(sheets, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("{\"sheets\": [\n")
        for si, s in enumerate(sheets):
            f.write("  {\"name\": %s, \"columns\": %s, \"rows\": [\n" % (json.dumps(s["name"]), json.dumps(s["columns"])))
            f.write(",\n".join("    " + json.dumps(r) for r in s["rows"]))
            f.write("\n  ]}%s\n" % ("," if si < len(sheets) - 1 else ""))
        f.write("]}\n")


def run_build(build_data, xlsx, out, seed):
    env = dict(os.environ, PYTHONHASHSEED=str(seed))
    subprocess.run([sys.executable, build_data, xlsx, "--output", out], check=True, env=env,
                   stdout=subprocess.DEVNULL)
    with open(out, encoding="utf-8") as f:
        text = f.read()
    assert text.startswith("const D=") and text.endswith(";\n")
    return text[len("const D="):-2]


# ── numeric helper golden ─────────────────────────────────────────────────────
def lcg_values(seed, n):
    """Mirrored in the JS test: exact integer LCG, values scaled by 10**k (k >= 0, exact)."""
    s, vals = seed, []
    for _ in range(n):
        s = (s * 1664525 + 1013904223) % 4294967296
        vals.append((s, (s / 4294967296 - 0.5) * 10 ** (s % 10)))
    return vals


def numeric_golden():
    cases = []
    for n in [0, 1, 7, 8, 9, 16, 17, 127, 128, 129, 257, 1025, 8192, 8193, 9000]:
        seed = 1000 + n
        pairs = lcg_values(seed, n)
        vals = [v for _, v in pairs]
        with_nan = [np.nan if s % 7 == 0 else v for s, v in pairs]
        labels = ["k%d" % (s % 3) for s, _ in pairs]
        case = {"seed": seed, "n": n, "sum": float(pd.Series(vals, dtype="float64").sum())}
        m = pd.Series(with_nan, dtype="float64").mean()
        case["mean"] = None if pd.isna(m) else float(m)
        case["pysum"] = float(sum(vals))
        if n:
            g = pd.DataFrame({"k": labels, "v": with_nan}).groupby("k", sort=False)["v"]
            case["groupSum"] = [[k, float(v)] for k, v in g.sum().items()]
            case["groupMean"] = [[k, None if pd.isna(v) else float(v)] for k, v in g.mean().items()]
        cases.append(case)
    xs = [12.03125, 0.03125, -0.03125, 2.675, 0.00005, 1.00005, 2.00015, 81.25, 33.333333333333336,
          66.66666666666667, 1e-9, 123456.78905, 5.55555, 100.0, 7.00005, 3.14159265, 1e20, 4503599627370497.0]
    for i in range(120):
        xs.append(rng.randint(0, 99999) / 32.0)
        xs.append(rng.randint(0, 10 ** 6) / rng.randint(1, 9999))
    return {"cases": cases, "round4": [[x, round(x, 4)] for x in xs]}


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: make_fixtures.py /path/to/build_data.py")
    build_data = os.path.abspath(sys.argv[1])
    with tempfile.TemporaryDirectory() as tmp:
        xlsx = os.path.join(tmp, "synthetic.xlsx")
        write_xlsx(xlsx)
        golden_a = run_build(build_data, xlsx, os.path.join(tmp, "a.js"), 0)
        golden_b = run_build(build_data, xlsx, os.path.join(tmp, "b.js"), 12345)
        assert golden_a == golden_b, "build_data.py output depends on PYTHONHASHSEED"
        dump_workbook(workbook_json(xlsx), os.path.join(HERE, "workbook.json"))
    with open(os.path.join(HERE, "golden-d.json"), "w", encoding="utf-8") as f:
        f.write(golden_a + "\n")
    with open(os.path.join(HERE, "numeric-golden.json"), "w", encoding="utf-8") as f:
        json.dump(numeric_golden(), f)
        f.write("\n")
    print("wrote workbook.json, golden-d.json, numeric-golden.json to", HERE)


if __name__ == "__main__":
    main()
