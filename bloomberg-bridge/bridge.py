"""
HTTP bridge: Bloomberg Terminal (Desktop API) -> JSON for AlphaSignal server.

Requires:
  - Bloomberg Terminal logged in on this PC
  - Python 3.9+
  - pip install -r requirements.txt

Run (PowerShell):
  cd bloomberg-bridge
  python -m venv .venv
  .\\.venv\\Scripts\\activate
  pip install -r requirements.txt
  python bridge.py

Default: http://127.0.0.1:5055/health  — routes: /snapshot, /earnings

Point AlphaSignal at it (same machine as Terminal):
  set BLOOMBERG_BRIDGE_URL=http://127.0.0.1:5055
  optional: set BLOOMBERG_BRIDGE_SECRET=yourtoken
"""
from __future__ import annotations

import os
import re
import socket
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request

import pandas as pd

_PDBLP_IMPORT_ERROR = ""

try:
    from pdblp import BCon
except Exception as exc:  # ImportError / missing Bloomberg blpapi binaries
    BCon = None  # type: ignore
    _PDBLP_IMPORT_ERROR = repr(exc)

app = Flask(__name__)
PORT = int(os.environ.get("BRIDGE_PORT", os.environ.get("PORT", "5055")))
# Listen address: 127.0.0.1 = this PC only; 0.0.0.0 = LAN/VPN (bridge must run on the PC that has Terminal)
BRIDGE_BIND = os.environ.get("BRIDGE_BIND", "127.0.0.1").strip() or "127.0.0.1"
SECRET = os.environ.get("BLOOMBERG_BRIDGE_SECRET", "").strip()

FLDS = [
    "BEST_PE_NTM",
    "PE_RATIO",
    "BEST_PEG_RATIO",
    "BEST_TARGET_MEDIAN",
    "SALES_YOY_GR",
    "BEST_EPS_GROWTH",
]

_bcon = None


def map_to_bb_security(symbol: str, bb_hint: str | None) -> str:
    if bb_hint and bb_hint.strip():
        return bb_hint.strip()
    s = symbol.strip().upper()
    if not s:
        return ""
    if s in ("BRK.B", "BRK-B"):
        return "BRK/B US Equity"
    m = re.match(r"^(\d+)\.HK$", s, re.I)
    if m:
        return f"{m.group(1)} HK Equity"
    if re.search(r"\.L$", s, re.I):
        return re.sub(r"\.L$", "", s, flags=re.I) + " LN Equity"
    if re.search(r"\.PA$", s, re.I):
        return re.sub(r"\.PA$", "", s, flags=re.I) + " FP Equity"
    if re.search(r"\.DE$", s, re.I):
        return re.sub(r"\.DE$", "", s, flags=re.I) + " GR Equity"
    if re.search(r"\.NS$", s, re.I):
        return re.sub(r"\.NS$", "", s, flags=re.I) + " IS Equity"
    if re.search(r"\.AS$", s, re.I):
        return re.sub(r"\.AS$", "", s, flags=re.I) + " NA Equity"
    if re.search(r"\.T$", s, re.I):
        return re.sub(r"\.T$", "", s, flags=re.I) + " JT Equity"
    if re.match(r"^[A-Z]{1,5}$", s):
        return f"{s} US Equity"
    return s.replace(".", "/") + " US Equity"


def get_bcon():
    global _bcon
    if BCon is None:
        raise RuntimeError("Install pdblp: pip install pdblp")
    if _bcon is None:
        _bcon = BCon(timeout=20000, debug=False, port=8194)
        _bcon.start()
    return _bcon


def check_secret() -> bool:
    if not SECRET:
        return True
    return request.headers.get("Authorization", "") == f"Bearer {SECRET}"


def first_float(val):
    if val is None:
        return None
    try:
        import math

        if hasattr(val, "item"):
            val = val.item()
        if val is None:
            return None
        x = float(val)
        if math.isnan(x) or math.isinf(x):
            return None
        return x
    except Exception:
        return None


@app.get("/health")
def health():
    out = {
        "ok": True,
        "pdblp_installed": BCon is not None,
        "listen": "http://%s:%s" % (BRIDGE_BIND, PORT),
        "routes": ["/health", "/snapshot", "/earnings"],
        "hint_url_other_pc": None
        if BRIDGE_BIND == "127.0.0.1"
        else "http://%s:%s" % (_guess_lan_ip(), PORT),
    }
    if SECRET:
        out["auth_required_for_data_routes"] = True
        out[
            "auth_hint"
        ] = "Use header: Authorization: Bearer <same value as BLOOMBERG_BRIDGE_SECRET>. Browser address bar GET returns 401 if secret is set."
    else:
        out["auth_required_for_data_routes"] = False
        out[
            "auth_hint"
        ] = "No BLOOMBERG_BRIDGE_SECRET on server — /snapshot and /earnings are open."
    return jsonify(out)


@app.get("/snapshot")
def snapshot():
    if not check_secret():
        return jsonify({"error": "unauthorized"}), 401
    sym = request.args.get("symbol", "").strip()
    bb_arg = request.args.get("bb", "").strip()
    if not sym and not bb_arg:
        return jsonify({"error": "symbol or bb required"}), 400
    sec = map_to_bb_security(sym or bb_arg.split()[0], bb_arg or None)
    try:
        con = get_bcon()
        df = con.ref(sec, FLDS)
    except Exception as e:
        return jsonify({"error": str(e), "bbSecurity": sec}), 503

    if df is None or getattr(df, "empty", True):
        return jsonify({"error": "no data", "bbSecurity": sec}), 503

    r = df.iloc[0]

    def cell(name):
        if name not in df.columns:
            return None
        return first_float(r[name])

    out = {
        "bbSecurity": sec,
        "ticker": sym or sec.split()[0],
        "forwardPE": cell("BEST_PE_NTM"),
        "trailingPE": cell("PE_RATIO"),
        "pegRatio": cell("BEST_PEG_RATIO"),
        "targetMeanPrice": cell("BEST_TARGET_MEDIAN"),
        "revenueGrowth": cell("SALES_YOY_GR"),
        "earningsGrowth": cell("BEST_EPS_GROWTH"),
    }
    return jsonify(out)


def _pandas_ts_to_iso(ts) -> str:
    """Normalize pandas Timestamp / datetime / string to YYYY-MM-DD."""
    try:
        if ts is None or (isinstance(ts, float) and str(ts) == "nan"):
            return ""
        if hasattr(ts, "to_pydatetime"):
            return ts.strftime("%Y-%m-%d")
        if hasattr(ts, "strftime"):
            return ts.strftime("%Y-%m-%d")
        s = str(ts).strip()
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return s[:10]
    except Exception:
        pass
    return ""


def _ref_get(row, fld: str):
    """Pull a Bloomberg ref() field from one row (pdblp column layout varies)."""
    try:
        if fld in row.index:
            v = row[fld]
            if hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    pass
            if pd.isna(v):
                return None
            return v
    except Exception:
        pass
    try:
        for k in row.index:
            if str(k).strip() == fld:
                v = row[k]
                if pd.isna(v):
                    return None
                return v
    except Exception:
        pass
    return None


def _report_typ_to_ui(raw) -> str | None:
    t = str(raw or "").strip().lower()
    if not t:
        return None
    if any(x in t for x in ("after", "aft", "pm", "close", "cl")):
        return "post-market"
    if any(x in t for x in ("bef", "bmo", "pre", "morn", "open")):
        return "pre-market"
    return "during-market"


def _bh_eps_history(con, sec: str, max_rows: int = 4):
    """Best-effort quarterly comparable EPS trail via BDH (field availability varies by listing)."""
    try:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=1100)
        df = con.bdh(sec, ["IS_COMP_EPS"], start.strftime("%Y%m%d"), end.strftime("%Y%m%d"))
    except Exception:
        return []
    if df is None or getattr(df, "empty", True):
        return []
    picked = []
    seen_eps = set()
    for col in df.columns:
        cname = str(col[1] if isinstance(col, tuple) and len(col) > 1 else col)
        if "IS_COMP_EPS" not in cname:
            continue
        ser = df[col].dropna()
        tail = ser.tail(max(32, max_rows * 12))
        for idx, val in tail.iloc[::-1].items():
            try:
                v = round(float(val), 6)
            except Exception:
                continue
            if abs(v) > 1e6:
                continue
            iso = _pandas_ts_to_iso(idx)
            if not iso:
                continue
            if v in seen_eps:
                continue
            seen_eps.add(v)
            try:
                q = datetime.strptime(iso, "%Y-%m-%d").strftime("%b %Y")
            except Exception:
                q = iso
            picked.append(
                {
                    "quarter": q,
                    "date": iso,
                    "epsActual": str(round(v, 4)).rstrip("0").rstrip("."),
                    "epsEstimate": None,
                    "epsSurprise": None,
                    "beat": None,
                }
            )
            if len(picked) >= max_rows:
                return picked
        break
    return picked


EARN_REF_FLDS = [
    "EXPECTED_REPORT_DT",
    "EXPECTED_REPORT_TYP",
    "BEST_EPS",
    "BEST_FPERIOD_END_DT",
]
@app.get("/earnings")
def earnings():
    if not check_secret():
        return jsonify({"error": "unauthorized"}), 401
    sym = request.args.get("symbol", "").strip()
    bb_arg = request.args.get("bb", "").strip()
    if not sym and not bb_arg:
        return jsonify({"error": "symbol or bb required"}), 400
    sec = map_to_bb_security(sym or bb_arg.split()[0], bb_arg or None)
    try:
        con = get_bcon()
        df = con.ref(sec, EARN_REF_FLDS)
    except Exception as e:
        return jsonify({"error": str(e), "bbSecurity": sec}), 503

    if df is None or getattr(df, "empty", True):
        return jsonify({"error": "no data", "bbSecurity": sec}), 503

    r = df.iloc[0]

    nxt_dt = _ref_get(r, "EXPECTED_REPORT_DT")
    nxt_typ = _ref_get(r, "EXPECTED_REPORT_TYP")
    best_eps = _ref_get(r, "BEST_EPS")
    fped = _ref_get(r, "BEST_FPERIOD_END_DT")

    next_iso = ""
    if nxt_dt is not None:
        try:
            if not pd.isna(nxt_dt):
                next_iso = pd.Timestamp(nxt_dt).strftime("%Y-%m-%d")
        except Exception:
            next_iso = _pandas_ts_to_iso(nxt_dt)

    est = None
    be = first_float(best_eps)
    if be is not None:
        est = str(round(be, 4)).rstrip("0").rstrip(".")

    earnings_time = _report_typ_to_ui(nxt_typ)
    fq = ""
    if fped is not None:
        fq_iso = _pandas_ts_to_iso(fped)
        if fq_iso:
            try:
                fq = "FY period end " + datetime.strptime(fq_iso, "%Y-%m-%d").strftime("%b %d, %Y")
            except Exception:
                fq = fq_iso

    hist = []
    try:
        hist = _bh_eps_history(con, sec, max_rows=4)
    except Exception:
        hist = []

    return jsonify(
        {
            "bbSecurity": sec,
            "ticker": sym or sec.split()[0],
            "nextEarningsDate": next_iso or None,
            "epsEstimate": est,
            "earningsTime": earnings_time,
            "quarter": fq or None,
            "history": hist,
            "calendarPrimarySource": "bloomberg_bridge",
        }
    )

def _guess_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("10.254.254.254", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    if BCon is None:
        print("ERROR: Bloomberg Python API did not load (pdblp / blpapi).", file=sys.stderr)
        if _PDBLP_IMPORT_ERROR:
            print("Detail: %s" % _PDBLP_IMPORT_ERROR, file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "Bloomberg Terminal can be running; you still need Bloomberg's pip wheel:",
            file=sys.stderr,
        )
        print("", file=sys.stderr)
        print(
            "  pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi",
            file=sys.stderr,
        )
        print("  pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)
    lan = _guess_lan_ip()
    print("Bloomberg bridge listening on http://%s:%s — Terminal must stay logged in" % (BRIDGE_BIND, PORT))
    if BRIDGE_BIND in ("0.0.0.0", "::"):
        print("  Other PCs on your network can use: http://%s:%s  (set Windows Firewall inbound TCP %s)" % (lan, PORT, PORT))
        if not SECRET:
            print("  WARNING: set BLOOMBERG_BRIDGE_SECRET for any non-local use.", file=sys.stderr)
    else:
        print("  This PC only. For another PC on LAN set BRIDGE_BIND=0.0.0.0")
    app.run(host=BRIDGE_BIND, port=PORT, threaded=True)
