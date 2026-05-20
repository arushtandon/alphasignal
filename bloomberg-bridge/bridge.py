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


def _numpy_pdblp_numeric_compat() -> None:
    """pdblp parses Bloomberg responses using np.NaN (removed in NumPy 2.x). Patch the loaded module."""
    import sys

    try:
        if "numpy" not in sys.modules:
            __import__("numpy")
        np_mod = sys.modules["numpy"]
        nan = getattr(np_mod, "nan")
        try:
            d = getattr(np_mod, "__dict__", None)
            if isinstance(d, dict):
                d.setdefault("NaN", nan)
                d.setdefault("NAN", nan)
        except Exception:
            pass
        setattr(np_mod, "NaN", nan)
        setattr(np_mod, "NAN", nan)
    except Exception:
        pass


_numpy_pdblp_numeric_compat()

import os
import re
import socket
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request

import pandas as pd

_PDBLP_IMPORT_ERROR = ""

# pdblp imports `numpy as np` and assigns np.NaN when fields are missing; patch again post-pandas.
_numpy_pdblp_numeric_compat()

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

# Bump when changing ref parsing so /health proves which code is running on the Bloomberg PC.
BRIDGE_BUILD = "20260520-nse-in-equity-mapping"

# Legacy name retained for README references — global equity BDP staples + prior bridge fallbacks.
FLDS = [
    "PE_RATIO",
    "BEST_PEG_RATIO",
    "IS_EPS",
    "EPS_GROWTH",
    "SALES_GROWTH",
    "BEST_PE_NTM",
    "SALES_YOY_GR",
    "BEST_EPS_GROWTH",
    "BEST_TARGET_MEDIAN",
]

# Snapshot: each tuple is (ordered Bloomberg candidates, JSON key). First non-empty ref() wins.
SAFE_SNAPSHOT_BB_FIELDS = [
    (["PX_LAST"], "currentPrice"),
    (["CUR_MKT_CAP"], "marketCap"),
    (["BEST_PE_NTM"], "forwardPE"),
    (["PE_RATIO"], "trailingPE"),
    (["BEST_PEG_RATIO"], "pegRatio"),
    (["BEST_TARGET_MEDIAN"], "targetMeanPrice"),
    (["SALES_GROWTH", "SALES_YOY_GR"], "revenueGrowth"),
    (["EPS_GROWTH", "BEST_EPS_GROWTH"], "earningsGrowth"),
    (["IS_EPS"], "fundamentalTrailingEps"),
    (["DEBT_TO_EQ_RATIO"], "debtToEquity"),
    (["RETURN_ON_CAPITAL_ADJ"], "returnOnCapital"),
    (["RETURN_ON_COMMON_EQUITY_ADJUSTED"], "returnOnEquity"),
    (["RETURN_ON_ASSET_PERCENT"], "returnOnAssets"),
    (["CURRENT_RATIO"], "currentRatio"),
    (["OPER_MARGIN"], "operatingMargins"),
    (["GROSS_MARGIN"], "grossMargins"),
    (["FREE_CASH_FLOW_YIELD_CURR"], "freeCashFlowYield"),
    (["SHORT_INT_RATIO"], "shortInterestRatio"),
]

# Next-earnings refs; time/period also resolved via *_CANDIDATE lists below.
EARN_HEADER_REF_FIELDS = [
    "EXPECTED_REPORT_DT",
    "EXPECTED_REPORT_TYP",
    "EXPECTED_REPORT_PERIOD",
    "BEST_EPS",
    "BEST_SALES",
    "BEST_EBITDA",
    "BEST_NET_INCOME",
    "BEST_FFQ",
    "BEST_FPERIOD_END_DT",
]

# BDP mnemonic candidates for wall-clock timing (listing-dependent; Terminal FLDS verifies).
EXPECTED_REPORT_TIME_CANDIDATES = [
    "EXPECTED_REPORT_TIME",
    "NEXT_EARN_TIMING",
    "EARN_TIMING",
    "EXPECTED_RELEASE_TM",
]

EXPECTED_REPORT_PERIOD_CANDIDATES = [
    "EXPECTED_REPORT_PERIOD",
    "NEXT_EARN_EXPECTED_PERIOD",
    "EXPECTED_FISCAL_PERIOD",
]

QUARTERLY_METRIC_GROUPS = [
    (
        [
            "IS_COMP_EPS",
            "IS_EPS",
            "UNDERLYING_DILUTED_EPS",
            "DILUTED_EPS",
            "TRAIL_TWELVE_MTH_EPS",
            "NORMALIZED_EPS_FROM_OPS",
        ],
        "epsActual",
    ),
    (["SALES_REV_TURN"], "revenueActual"),
    (["EBITDA"], "ebitdaActual"),
    (["NET_INCOME"], "netIncomeActual"),
    (["EBIT_ADJ_TOT", "EBIT"], "operatingProfitActual"),
]

# Quarterly mean / consensus EPS (BDH quarterly). Tried until one returns coverage.
QUARTERLY_EPS_ESTIMATE_FIELDS = [
    "FQ_EPS_MEAN",
    "MEAN_EPS_FQ",
    "CQ_EPS_MEAN",
    "BFGS_EPS_MEAN",
    "EXPECTED_EPSQF",
    "EPS_MEAN_REC",
    "PE_CONS_EPS",
    "BEST_EPS",
]

QUARTERLY_SURPRISE_FIELDS = [
    "FQ_EPS_PERCENT_SURPRISE",
    "FQ_EPS_SURPRISE",
    "EPS_PERCENT_SURPRISE",
]

QUARTERLY_ANCHOR_FIELDS = ["EARN_REPORT_DT", "ECO_RELEASE_DT"]

BB_QUARTERLY_ELMS_VARIANTS = [
    [("periodicitySelection", "QUARTERLY"), ("adjustmentFollowDPDF", "N")],
    [("periodicitySelection", "QUARTERLY")],
]

# Excel BDS: =BDS(...,"EARN_ANN_DT_TIME_HIST_WITH_EPS", startrow,endrow,startcol,endcol,headers=y)
EARN_ANN_BULK_FIELD = "EARN_ANN_DT_TIME_HIST_WITH_EPS"
EARN_ANN_BULK_OVRDS_VARIANTS = [
    [("startrow", "1"), ("endrow", "4"), ("startcol", "1"), ("endcol", "3"), ("headers", "Y")],
    [("START_ROW", "1"), ("END_ROW", "4"), ("START_COL", "1"), ("END_COL", "3"), ("HEADERS", "Y")],
    [("ROWS", "1:4"), ("COLUMNS", "1:3")],
]

EPS_ACTUAL_FOR_AE_SERIES = ("IS_COMP_EPS_ADJUSTED", "IS_COMP_EPS", "IS_EPS")

_bcon = None


def clean_bridge_symbol(raw: str) -> str:
    """Strip stray `^` from query params (Windows CMD / copy-paste artifacts)."""
    s = (raw or "").strip().replace("^", "")
    return s.strip()

# Yahoo *.NS symbols often diverge from Bloomberg NSE mnemonics (hyphens, marketing names).
NSE_BB_OVERRIDES: dict[str, str] = {
    "BAJAJ-AUTO": "BAJAUT",
    "M&M": "MM",
}


def normalize_bb_security_hint(raw: str | None) -> str | None:
    """Bloomberg tickers use spaces (e.g. `AAPL US Equity`). Fix common pastes `AAPL:US:Equity`."""
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip().replace("^", "")
    if "://" not in s and ":" in s:
        s = re.sub(r"\s*:\s*", " ", s)
    return " ".join(s.split())


def map_to_bb_security(symbol: str, bb_hint: str | None) -> str:
    if bb_hint and bb_hint.strip():
        norm = normalize_bb_security_hint(bb_hint)
        return (norm or bb_hint).strip()
    s = symbol.strip().upper()
    if not s:
        return ""
    if s in ("BRK.B", "BRK-B"):
        return "BRK/B US Equity"
    m_space = re.match(r"^(\d+)\s+HK$", s, re.I)
    if m_space:
        return f"{m_space.group(1)} HK Equity"
    m_space_j = re.match(r"^(\d+)\s+JT$", s, re.I)
    if m_space_j:
        return f"{m_space_j.group(1)} JT Equity"
    m = re.match(r"^(\d+)\.HK$", s, re.I)
    if m:
        return f"{m.group(1)} HK Equity"
    if re.search(r"\.L$", s, re.I):
        return re.sub(r"\.L$", "", s, flags=re.I) + " LN Equity"
    if re.search(r"\.PA$", s, re.I):
        return re.sub(r"\.PA$", "", s, flags=re.I) + " FP Equity"
    if re.search(r"\.DE$", s, re.I):
        return re.sub(r"\.DE$", "", s, flags=re.I) + " GR Equity"
    # NSE (Yahoo-style *.NS): Bloomberg uses exchange code "IS" → "TICKER IS Equity" (not country "IN").
    # NSE (Yahoo *.NS): list as TICKER **IN Equity** (India listing).
    if re.search(r"\.NS$", s, re.I):
        root = re.sub(r"\.NS$", "", s, flags=re.I).strip().upper()
        root = NSE_BB_OVERRIDES.get(root, root.replace("-", " "))
        root = " ".join(root.split())
        return f"{root} IN Equity"
    # BSE Bombay (Yahoo-style *.BO)
    if re.search(r"\.BO$", s, re.I):
        return re.sub(r"\.BO$", "", s, flags=re.I) + " IB Equity"
    if re.search(r"\.AS$", s, re.I):
        return re.sub(r"\.AS$", "", s, flags=re.I) + " NA Equity"
    if re.search(r"\.ST$", s, re.I):
        return re.sub(r"\.ST$", "", s, flags=re.I) + " SS Equity"
    if re.search(r"\.T$", s, re.I):
        return re.sub(r"\.T$", "", s, flags=re.I) + " JT Equity"
    if re.search(r"\.SW$", s, re.I):
        return re.sub(r"\.SW$", "", s, flags=re.I) + " SW Equity"
    if re.search(r"\.SI$", s, re.I):
        return re.sub(r"\.SI$", "", s, flags=re.I) + " SP Equity"
    if re.search(r"\.AX$", s, re.I):
        return re.sub(r"\.AX$", "", s, flags=re.I) + " AU Equity"
    if re.search(r"\.OL$", s, re.I):
        return re.sub(r"\.OL$", "", s, flags=re.I) + " NO Equity"
    if re.search(r"\.CO$", s, re.I):
        return re.sub(r"\.CO$", "", s, flags=re.I) + " DC Equity"
    if re.search(r"\.MI$", s, re.I):
        return re.sub(r"\.MI$", "", s, flags=re.I) + " IM Equity"
    if re.search(r"\.MC$", s, re.I):
        return re.sub(r"\.MC$", "", s, flags=re.I) + " SM Equity"
    if re.search(r"\.TO$", s, re.I):
        return re.sub(r"\.TO$", "", s, flags=re.I) + " CN Equity"
    if re.search(r"\.V$", s, re.I):
        return re.sub(r"\.V$", "", s, flags=re.I) + " CN Equity"
    if re.match(r"^[A-Z]{1,5}$", s):
        return f"{s} US Equity"
    if "." in s:
        return s.replace(".", "/") + " Equity"
    return f"{s} US Equity"


def get_bcon():
    global _bcon
    if BCon is None:
        raise RuntimeError("Install pdblp: pip install pdblp")
    if _bcon is None:
        _bcon = BCon(timeout=int(os.environ.get("BLOOMBERG_BRIDGE_BCON_MS", os.environ.get("BRIDGE_BCON_TIMEOUT_MS", "35000"))), debug=False, port=8194)
        _bcon.start()
    return _bcon


def reset_bloomberg_connection() -> None:
    """Recover from a half-open BCon session (e.g. after API exceptions)."""
    global _bcon
    stale = _bcon
    _bcon = None
    if stale is None:
        return
    try:
        stale.stop()
    except Exception:
        pass


def _session_dead(exc: BaseException) -> bool:
    """Blpapi / pdblp when Desktop API session is not usable (Terminal idle, reconnect, etc.)."""
    m = str(exc).lower().replace("`", "").replace("'", "")
    cls = getattr(exc.__class__, "__name__", "").lower()
    return (
        "session not started" in m
        or "0x00010009" in m
        or "invalidstate" in m
        or "invalid state" in m
        or cls == "invalidstateexception"
    )


def _exc_suggests_bloomberg_restart(exc: BaseException) -> bool:
    """True when the Bloomberg session likely needs a reconnect (e.g. after NumPy/API faults)."""
    if _session_dead(exc):
        return True
    m = str(exc).lower().replace("`", "").replace("'", "")
    cls = getattr(exc.__class__, "__name__", "").lower()
    # pdblp stack: `'np.NaN' was removed in the NumPy 2.0 release`
    return (
        cls == "referencedataresponse"
        or "referencedataresponse" in m
        or "reference data response" in m
        or "np.nan was removed in the numpy 2" in m
        or "numpy 2.0 release" in m
        or ("removed in the numpy 2" in m)
        or "attributeerror: module numpy has no attribute nan" in m
    )


def check_secret() -> bool:
    """Accept `Authorization: Bearer <token>`; ignore surrounding whitespace; Bearer case-insensitive."""
    if not SECRET:
        return True
    raw = (request.headers.get("Authorization") or "").strip()
    if not raw:
        return False
    low = raw.lower()
    if not low.startswith("bearer "):
        return False
    token = raw[7:].strip()
    return token == SECRET


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
        try:
            s = str(val).strip().replace(",", "").replace("%", "")
            x = float(s)
            import math

            if math.isnan(x) or math.isinf(x):
                return None
            return x
        except Exception:
            return None


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


def _bloomberg_soft(exc: BaseException) -> bool:
    cls = getattr(exc.__class__, "__name__", "").upper()
    msg = str(exc).upper()
    if cls == "VALUEERROR" and "SECURITY" in msg and ("UNKNOW" in msg or "UNKNOWN" in msg):
        return True
    if cls == "TYPEERROR" and "STRING INDICES" in msg:
        return True
    if cls in ("REFERENCE_DATA_RESPONSE", "REFERENCEDATARESPONSE"):
        return True
    s = msg
    return any(
        t in s
        for t in (
            "REFERENCE_DATA_RESPONSE",
            "REFERENCEDATARESPONSE",
            "INVALID_FIELD",
            "NOT_APPLICABLE",
            "UNKNOWN_FIELD",
            "UNKNOWN_SECURITY",
            "UNKNOW SECURITY",
            "INVALID_SECURITY",
            "INVALID_REQUEST",
            "UNSUPPORTED_OPERATION",
            "BAD_FIELD",
            "SECURITY NOT FOUND",
        )
    )


def ref_field_safe(con, sec: str, fld: str):
    """Single-field ref(); INVALID_FIELD yields None instead of aborting."""
    try:
        df = con.ref(sec, [fld])
        if df is None or getattr(df, "empty", True):
            return None
        # pdblp returns long-form columns [ticker, field, value], not wide keyed by mnemonic.
        cmap = {str(c).strip().lower(): c for c in df.columns}
        v_col = cmap.get("value")
        f_col = cmap.get("field")
        if v_col is not None:
            want = str(fld).strip()
            if f_col is not None:
                mask = df[f_col].astype(str).str.strip() == want
                hit = df.loc[mask]
                # Single-field requests normally return one row; tolerate odd field-cell mismatches.
                if hit.empty and len(df) == 1:
                    hit = df
                elif hit.empty:
                    return None
            else:
                hit = df
            v = hit.iloc[0][v_col]
            if pd.isna(v):
                return None
            return v
        r = df.iloc[0]
        if isinstance(r, pd.Series) or hasattr(r, "index"):
            return _ref_get(r, fld)
        return None
    except Exception as exc:
        # Session loss must propagate so routes can reset BCon and retry.
        if _session_dead(exc):
            raise
        # Per-field soft failures are common; never abort the whole /snapshot for one field.
        if not _bloomberg_soft(exc):
            try:
                import sys

                print(
                    "ref_field_safe %s %s: %s: %s"
                    % (sec, fld, exc.__class__.__name__, exc),
                    file=sys.stderr,
                )
            except Exception:
                pass
        return None


def ref_first_candidate(con, sec: str, candidates: list[str]):
    """Return first non-empty ref() among Bloomberg field names (order = preference)."""
    for fld in candidates:
        v = ref_field_safe(con, sec, fld)
        if v is None:
            continue
        try:
            if pd.isna(v):
                continue
        except Exception:
            pass
        return v
    return None


def _bb_ref_str(v) -> str | None:
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    s = str(v).strip()
    if not s or s.upper() in ("NA", "N/A", "NIL", "NONE"):
        return None
    return s


def fmt_trim_num(x: float | None, nd: int = 4):
    if x is None:
        return None
    try:
        s = str(round(float(x), nd)).rstrip("0").rstrip(".")
        return s or None
    except Exception:
        return None


def fmt_money_billions(x: float | None):
    """Large income-statement figures; keep raw when modest."""
    if x is None:
        return None
    try:
        ax = abs(float(x))
        if ax >= 1e9:
            return str(round(ax / 1e9, 3)).rstrip("0").rstrip(".") + "B"
        if ax >= 1e6:
            return str(round(ax / 1e6, 3)).rstrip("0").rstrip(".") + "M"
        return fmt_trim_num(float(x), 2)
    except Exception:
        return None


def _report_typ_to_ui(raw) -> str | None:
    """Map EXPECTED_REPORT_TYP text to AlphaSignal buckets; unknown strings return None (fall back to time field)."""
    t = str(raw or "").strip().lower()
    if not t:
        return None
    if any(x in t for x in ("after", "aft", "pm", "close", "cl")):
        return "post-market"
    if any(x in t for x in ("bef", "bmo", "pre", "morn", "open")):
        return "pre-market"
    if any(x in t for x in ("during", "intraday", "regular", "rth", "mkt hrs", "market hour")):
        return "during-market"
    return None


def _classification_from_bb_time(raw) -> str | None:
    """Infer pre/post from time string when EXPECTED_REPORT_TYP is empty."""
    t = str(raw or "").strip().lower()
    if not t:
        return None
    if any(
        x in t
        for x in (
            "after",
            "aft",
            "post",
            "pm",
            "p.m",
            "close",
            "closing",
            "afterhour",
            "after hour",
        )
    ):
        return "post-market"
    if any(
        x in t
        for x in (
            "bef",
            "bmo",
            "pre",
            "morn",
            "morning",
            "open",
            "a.m",
            "am ",
        )
    ):
        return "pre-market"
    return None


def _bdh_optional(con, sec: str, fld: str, start_yyyymmdd: str, end_yyyymmdd: str, elms=None):
    try:
        kw = dict(elms=elms) if elms else {}
        df = con.bdh(sec, [fld], start_yyyymmdd, end_yyyymmdd, **kw)
        return df if df is not None and not getattr(df, "empty", True) else None
    except Exception as exc:
        if _session_dead(exc):
            raise
        if _bloomberg_soft(exc):
            return None
        return None


def _series_sorted_desc(df) -> list[tuple[str, float]]:
    """Bloomberg historical frame -> newest-first (iso, value) pairs."""
    if df is None or getattr(df, "empty", True):
        return []
    col = df.iloc[:, 0]
    out = []
    for idx, val in col.items():
        if pd.isna(val):
            continue
        iso = _pandas_ts_to_iso(idx)
        if not iso:
            continue
        try:
            fv = float(val)
        except Exception:
            continue
        if abs(fv) > 1e18:
            continue
        out.append((iso, fv))
    out.sort(key=lambda z: z[0], reverse=True)
    uniq = []
    seen = set()
    for iso, fv in out:
        if iso in seen:
            continue
        seen.add(iso)
        uniq.append((iso, fv))
    return uniq


def _bdh_series_quarterly(con, sec: str, fld: str):
    """Try quarterly BDH; fall back to daily if needed."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=2200)
    sy, ey = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    for elms in BB_QUARTERLY_ELMS_VARIANTS:
        df = _bdh_optional(con, sec, fld, sy, ey, elms=tuple(elms))
        pts = _series_sorted_desc(df)
        # Asian / smaller histories: require at least two quarterly ticks; demanding 4+ dropped valid series.
        if len(pts) >= 2:
            return pts
    df = _bdh_optional(con, sec, fld, sy, ey, elms=None)
    return _series_sorted_desc(df)


def first_series_for_candidates(con, sec: str, candidates: list[str]) -> tuple[str | None, list[tuple[str, float]]]:
    for c in candidates:
        pts = _bdh_series_quarterly(con, sec, c)
        if pts:
            return c, pts
    return None, []


def _pct_change(prev: float | None, nxt: float | None):
    try:
        if prev is None or nxt is None or abs(prev) < 1e-12:
            return None
        return round(((nxt - prev) / abs(prev)) * 100, 4)
    except Exception:
        return None

def _bbelem_to_iso(val):
    """Turn Bloomberg ref/bdh scalar into YYYY-MM-DD when possible."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    iso = _pandas_ts_to_iso(val)
    if iso:
        return iso
    try:
        fv = float(val)
        if 30000 < fv < 65000:
            d = datetime(1899, 12, 30) + timedelta(days=int(round(fv)))
            return d.strftime("%Y-%m-%d")
    except Exception:
        pass
    return None


def _load_daily_px_asc(con, sec: str) -> list[tuple[str, float]]:
    """Calendar-daily-ish PX_LAST, oldest first."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=8 * 365)
    df = _bdh_optional(con, sec, "PX_LAST", start.strftime("%Y%m%d"), end.strftime("%Y%m%d"), None)
    pts_desc = _series_sorted_desc(df)
    return list(reversed(pts_desc))


def _index_last_before(px_asc: list[tuple[str, float]], iso: str) -> int | None:
    """Largest index with date strictly before iso (YYYY-MM-DD string compare OK)."""
    lo = [i for i, (d, _) in enumerate(px_asc) if d < iso]
    return lo[-1] if lo else None


def _index_first_on_or_after(px_asc: list[tuple[str, float]], iso: str) -> int | None:
    for i, (d, _) in enumerate(px_asc):
        if d >= iso:
            return i
    return None


def reaction_bundle_for_anchor(
    px_asc: list[tuple[str, float]],
    anchor_iso: str,
    next_earnings_timing: str | None,
) -> dict:
    """
    Price path around `anchor_iso` (often fiscal period end, not true press date).
    next_earnings_timing guides which leg to prefer for display (pre / during / post).
    """
    ip = _index_last_before(px_asc, anchor_iso)
    i0 = _index_first_on_or_after(px_asc, anchor_iso)
    out: dict = {
        "anchorDate": anchor_iso,
        "note": "Dates are usually fiscal period ends from fundamentals history; may differ from press/ECO time.",
    }
    if ip is None or i0 is None:
        return out
    prior_close = px_asc[ip][1]
    sess_close = px_asc[i0][1]
    i1 = i0 + 1 if i0 + 1 < len(px_asc) else None
    next_close = px_asc[i1][1] if i1 is not None else None
    out["priorSessionCloseDate"] = px_asc[ip][0]
    out["eventSessionDate"] = px_asc[i0][0]
    out["fromPriorCloseToEventSessionClosePct"] = _pct_change(prior_close, sess_close)
    if next_close is not None and i1 is not None:
        out["nextSessionDate"] = px_asc[i1][0]
        out["fromPriorCloseToNextSessionClosePct"] = _pct_change(prior_close, next_close)
    # Emphasize one leg for "current" next earnings call-style reading
    if next_earnings_timing == "post-market" and out.get("fromPriorCloseToNextSessionClosePct") is not None:
        out["headlinePctVsPriorClose"] = out["fromPriorCloseToNextSessionClosePct"]
        out["headlineLabel"] = "post-market: next full session vs prior close"
    elif next_earnings_timing == "pre-market" and out.get("fromPriorCloseToEventSessionClosePct") is not None:
        out["headlinePctVsPriorClose"] = out["fromPriorCloseToEventSessionClosePct"]
        out["headlineLabel"] = "pre-market: event session close vs prior close (approximation)"
    elif out.get("fromPriorCloseToEventSessionClosePct") is not None:
        out["headlinePctVsPriorClose"] = out["fromPriorCloseToEventSessionClosePct"]
        out["headlineLabel"] = "during market: event session vs prior close (approximation)"
    return out


def _bulkref_optional(con, sec: str, fld: str, ovrds: list[tuple[str, str]]):
    try:
        df = con.bulkref(sec, [fld], ovrds=ovrds)
        if df is not None and not getattr(df, "empty", True):
            return df
    except Exception as exc:
        if _session_dead(exc):
            raise
        if not _bloomberg_soft(exc):
            try:
                print(
                    "bulkref_optional %s %s: %s: %s"
                    % (sec, fld, exc.__class__.__name__, exc),
                    file=sys.stderr,
                )
            except Exception:
                pass
    return None


def _bulk_rows_by_position(df) -> dict[int, dict[str, object]]:
    """bulkref long frame -> position -> {element name -> value}."""
    if df is None or getattr(df, "empty", True) or not isinstance(df, pd.DataFrame):
        return {}
    cols = {str(c).strip().lower(): c for c in df.columns}
    pos_c = cols.get("position")
    name_c = cols.get("name")
    val_c = cols.get("value")
    if pos_c is None or name_c is None or val_c is None:
        return {}
    out: dict[int, dict[str, object]] = {}
    for _, r in df.iterrows():
        try:
            pos = int(pd.to_numeric(r[pos_c], errors="coerce"))
        except Exception:
            continue
        if pos != pos:  # NaN
            continue
        try:
            nm = str(r[name_c]).strip()
            out.setdefault(pos, {})[nm] = r[val_c]
        except TypeError:
            continue
    return out


def _bulk_pick_cell(cells: dict, *needles: str) -> object | None:
    nlow = tuple(s.lower() for s in needles)
    for k, v in cells.items():
        kl = str(k).lower().strip()
        if any(nd in kl for nd in nlow):
            return v
    return None


def _infer_ann_row_from_cells(cells: dict[str, object]) -> dict | None:
    """One BDS earnings-history row → announcementDate + Bef-/Aft-mkt bucket."""
    period = _bulk_pick_cell(cells, "period", "fiscal")
    period_s = _bb_ref_str(period)

    dval = _bulk_pick_cell(
        cells,
        "announcement date",
        "ann date",
        "announce date",
        "earnings announcement date",
    )
    if dval is None:
        dval = _bulk_pick_cell(cells, "date")
    ann_iso = _bbelem_to_iso(dval)
    if not ann_iso:
        return None

    tval = _bulk_pick_cell(
        cells,
        "announcement time",
        "ann time",
        "timing",
        "time",
        "mkt",
    )
    tstr = _bb_ref_str(tval) if tval is not None else None
    timing_ui = _bef_aft_cell_to_timing_ui(tstr)
    return {
        "announcementPeriod": period_s,
        "announcementDate": ann_iso,
        "announcementTimeRaw": tstr,
        "earningsReleaseTiming": timing_ui,
    }


def _bef_aft_cell_to_timing_ui(t: str | None) -> str:
    """Maps Excel-style 'Aft-mkt' / 'Bef-mkt' strings to AlphaSignal buckets."""
    s = (t or "").strip().lower()
    if not s:
        return "during-market"
    if any(x in s for x in ("aft", "after", "post", "pm", "close", "following")):
        return "post-market"
    if any(x in s for x in ("bef", "before", "pre", "bmo", "morn", "am ")):
        return "pre-market"
    return "during-market"


def _bulk_df_to_earn_ann_rows(df) -> list[dict]:
    if df is None or getattr(df, "empty", True):
        return []
    cols = {str(c).strip().lower(): c for c in df.columns}
    if "field" in cols:
        fcol = cols["field"]
        df = df[df[fcol].astype(str).str.strip() == EARN_ANN_BULK_FIELD].copy()
        if df.empty:
            return []
    by_pos = _bulk_rows_by_position(df)
    rows: list[dict] = []
    for pos in sorted(by_pos.keys()):
        row = _infer_ann_row_from_cells(by_pos[pos])
        if row:
            rows.append(row)
    rows.sort(key=lambda z: z["announcementDate"], reverse=True)
    return rows[:4]


def _fetch_earn_ann_table(con, sec: str) -> list[dict]:
    """Top 4 earnings announcement rows (Excel BDS EARN_ANN_DT_TIME_HIST_WITH_EPS)."""
    for ovrds in EARN_ANN_BULK_OVRDS_VARIANTS:
        df = _bulkref_optional(con, sec, EARN_ANN_BULK_FIELD, ovrds)
        if df is None:
            continue
        rows = _bulk_df_to_earn_ann_rows(df)
        if rows:
            return rows
    return []


def reaction_bundle_excel_earnings(
    px_asc: list[tuple[str, float]],
    announcement_iso: str,
    timing_ui: str | None,
) -> dict:
    """
    Excel BQL-style % change:
    - Aft-mkt: close on announcement session → next session close.
    - Bef-mkt / during: prior session close → announcement session close.
    """
    out: dict = {
        "anchorDate": announcement_iso,
        "methodology": "excel_bql_close_to_close",
        "timingUsed": timing_ui or "during-market",
    }
    i0 = _index_first_on_or_after(px_asc, announcement_iso)
    if i0 is None:
        out["note"] = "no PX_LAST session on/after announcement date"
        return out
    event_date = px_asc[i0][0]
    event_close = px_asc[i0][1]
    ip = _index_last_before(px_asc, event_date)
    if ip is None:
        out["note"] = "missing prior session for window"
        return out
    prior_close = px_asc[ip][1]
    out["priorSessionCloseDate"] = px_asc[ip][0]
    out["eventSessionDate"] = event_date

    is_aft = (timing_ui or "") == "post-market"
    if is_aft:
        i1 = i0 + 1 if i0 + 1 < len(px_asc) else None
        if i1 is None:
            out["note"] = "missing next session (after-market window)"
            return out
        next_close = px_asc[i1][1]
        out["nextSessionDate"] = px_asc[i1][0]
        leg = _pct_change(event_close, next_close)
        out["headlinePct"] = leg
        out["fromEventCloseToNextClosePct"] = leg
        out["headlineLabel"] = "Aft-mkt: announcement date close → next session close"
    else:
        leg = _pct_change(prior_close, event_close)
        out["headlinePct"] = leg
        out["fromPriorCloseToAnnouncementSessionClosePct"] = leg
        out["headlineLabel"] = "Bef-mkt/during: prior close → announcement session close"
    return out


def _bdh_quarterly_ae_series(
    con, sec: str, fld: str, ae: str
) -> list[tuple[str, float]]:
    """BDH fundamentals with Actual vs Estimate overrides (BQL-aligned AE=A| E when overrides work)."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=2200)
    sy, ey = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    combos: list[list[tuple[str, str]]] = []
    for pk, pv in (
        ("FUNDAMENTAL_PERIOD_TYPE", "Q"),
        ("FUNDAMENTAL_PERIOD_TYPE", "QUARTERLY"),
        ("FPT", "Q"),
    ):
        for root in (
            ("ACTUAL_OR_ESTIMATE", ae),
            ("Actual_Or_Estimate", ae),
            ("AE", ae),
        ):
            combos.append([(pk, pv), root])

    skip_ae = False
    for ovrds in combos:
        if skip_ae:
            break
        for elms in BB_QUARTERLY_ELMS_VARIANTS:
            try:
                df = con.bdh(sec, [fld], sy, ey, elms=tuple(elms), ovrds=list(ovrds))
            except TypeError:
                skip_ae = True
                break
            except Exception as exc:
                if _session_dead(exc):
                    raise
                continue
            pts = _series_sorted_desc(df)
            if len(pts) >= 2:
                return pts
    return []


def _lookup_sorted_pts(pts: list[tuple[str, float]], iso: str) -> float | None:
    for d, v in pts:
        if d == iso:
            try:
                return float(v)
            except Exception:
                return None
    return None


def _pct_surprise_actual_est(actual: float | None, est: float | None) -> float | None:
    if actual is None or est is None:
        return None
    try:
        e = float(est)
        if abs(e) < 1e-12:
            return None
        return round((float(actual) - e) / abs(e) * 100.0, 4)
    except Exception:
        return None


def _fmt_signed_surprise_pct(p: float | None) -> str | None:
    if p is None or p != p:
        return None
    return (("+" if p >= 0 else "") + str(round(p, 2)) + "%")


def _fetch_quarterly_ae_surprise_grid(con, sec: str) -> list[dict]:
    """
    Last four fiscal quarters EPS/revenue actual vs estimate + surprise %
    (parallel to BQL IS_EPS / SALES_REV_TURN with FPT=Q, AE=A|E).
    """
    pts_a: list[tuple[str, float]] = []
    pts_e: list[tuple[str, float]] = []
    fld_eps: str | None = None
    for fld in EPS_ACTUAL_FOR_AE_SERIES:
        cand_a = _bdh_quarterly_ae_series(con, sec, fld, "A")
        if len(cand_a) >= 2:
            fld_eps = fld
            pts_a = cand_a
            pts_e = _bdh_quarterly_ae_series(con, sec, fld, "E")
            break

    if not pts_a:
        for fld in EPS_ACTUAL_FOR_AE_SERIES:
            cand = _bdh_series_quarterly(con, sec, fld)
            if cand:
                fld_eps = fld
                pts_a = cand
                break
    if not pts_a:
        return []

    _, est_pts_fallback = first_series_for_candidates(con, sec, QUARTERLY_EPS_ESTIMATE_FIELDS)
    rev_a = _bdh_quarterly_ae_series(con, sec, "SALES_REV_TURN", "A")
    if not rev_a:
        rev_a = _bdh_series_quarterly(con, sec, "SALES_REV_TURN")
    rev_e = _bdh_quarterly_ae_series(con, sec, "SALES_REV_TURN", "E")

    rows_out: list[dict] = []
    for iso, av in pts_a[:12]:
        if len(rows_out) >= 4:
            break
        try:
            av_f = float(av)
        except Exception:
            continue

        ev = _lookup_sorted_pts(pts_e, iso) if pts_e else None
        if ev is None and est_pts_fallback:
            ev = _lookup_sorted_pts(est_pts_fallback, iso)

        rav = _lookup_sorted_pts(rev_a, iso) if rev_a else None
        rev_es = _lookup_sorted_pts(rev_e, iso) if rev_e else None

        row: dict = {
            "date": iso,
            "epsFieldActual": fld_eps,
            "historyRowSource": "bdh_ae_quarterly_grid",
        }
        try:
            row["quarter"] = datetime.strptime(iso, "%Y-%m-%d").strftime("%b %Y")
        except Exception:
            row["quarter"] = iso
        row["epsActual"] = fmt_trim_num(av_f, 4)
        ev_f = first_float(ev) if ev is not None else None
        if ev_f is not None:
            row["epsEstimate"] = fmt_trim_num(ev_f, 4)
        eps_sp = _pct_surprise_actual_est(av_f, ev_f)
        if eps_sp is not None:
            row["epsSurprise"] = _fmt_signed_surprise_pct(eps_sp)
            row["epsSurpriseSource"] = "computed_actual_minus_estimate_pct"
            row["beat"] = bool(av_f >= ev_f) if ev_f is not None else None

        if rav is not None:
            row["revenueActual"] = fmt_money_billions(rav)
        if rev_es is not None:
            row["revenueEstimate"] = fmt_money_billions(rev_es)
        rsp = _pct_surprise_actual_est(rav, rev_es)
        if rsp is not None:
            row["revenueSurprise"] = _fmt_signed_surprise_pct(rsp)
            row["revenueSurpriseSource"] = "computed_actual_minus_estimate_pct"
        rows_out.append(row)
    return rows_out


def _merge_ann_into_grid(
    px_asc: list[tuple[str, float]],
    grid: list[dict],
    ann: list[dict],
    fallback_timing: str | None,
) -> list[dict]:
    """Zip Excel-style BDS top-4 announcements (by recency with grid) onto fiscal quarter rows."""
    for i, row in enumerate(grid):
        if i < len(ann):
            ev = ann[i]
            ann_dt = ev["announcementDate"]
            tim = ev.get("earningsReleaseTiming")
            row["announcementDate"] = ann_dt
            row["announcementTimeRaw"] = ev.get("announcementTimeRaw")
            row["earningsReleaseTiming"] = tim
            pe = ev.get("announcementPeriod")
            if pe:
                row["announcementPeriod"] = pe
            row["announcementAlignedIndex"] = i
            row["historyRowSource"] = "excel_bds_ann+bdh_ae_grid"
            row["reportOrAnnounceDate"] = ann_dt
            if px_asc:
                row["stockReaction"] = reaction_bundle_excel_earnings(px_asc, ann_dt, tim)
        else:
            fiscal = row.get("date")
            if px_asc and fiscal:
                row["stockReaction"] = reaction_bundle_for_anchor(px_asc, str(fiscal), fallback_timing)
    return grid


def _eps_surprise_pct_normalize(x: float) -> float:
    """Bloomberg often returns surprise as 0.12 vs 12 — normalize to percent points."""
    try:
        v = float(x)
    except Exception:
        return float("nan")
    if abs(v) <= 1.25:
        v *= 100.0
    return v


def _build_quarter_rows_legacy(con, sec: str, next_tim_hint: str | None) -> list[dict]:
    """Legacy: align last four fiscal quarter points across BDH metrics (no BDS announcement table)."""
    series_by_key: dict[str, list[tuple[str, float]]] = {}
    for cands, jkey in QUARTERLY_METRIC_GROUPS:
        _, pts = first_series_for_candidates(con, sec, list(cands))
        if pts:
            series_by_key[jkey] = pts

    surprise_pts: list[tuple[str, float]] = []
    surprise_src = None
    for sf in QUARTERLY_SURPRISE_FIELDS:
        _, pts = first_series_for_candidates(con, sec, [sf])
        if pts:
            surprise_pts = pts
            surprise_src = sf
            break

    anchor_pts: list[tuple[str, float]] = []
    for af in QUARTERLY_ANCHOR_FIELDS:
        _, pts = first_series_for_candidates(con, sec, [af])
        if pts:
            anchor_pts = pts
            break

    _, estimate_pts = first_series_for_candidates(con, sec, QUARTERLY_EPS_ESTIMATE_FIELDS)

    # Prefer IS_COMP_EPS dates, but revenue-only BDH can diverge — union quarter-ends so EPS can still match.
    iso_set: list[str] = []
    seen_iso: set[str] = set()
    for pts in series_by_key.values():
        for iso, _ in pts[:36]:
            if iso not in seen_iso:
                seen_iso.add(iso)
                iso_set.append(iso)
    iso_set.sort(reverse=True)
    pick = iso_set[:10]
    if not pick:
        return []

    def lookup(pts: list[tuple[str, float]], iso: str) -> float | None:
        for d, v in pts:
            if d == iso:
                return v
        return None

    px_asc = _load_daily_px_asc(con, sec)
    rows = []
    for iso in pick:
        row: dict = {"date": iso}
        try:
            row["quarter"] = datetime.strptime(iso, "%Y-%m-%d").strftime("%b %Y")
        except Exception:
            row["quarter"] = iso
        # metrics
        for jk, pts in series_by_key.items():
            v = lookup(pts, iso)
            if v is None:
                continue
            if jk == "epsActual":
                row[jk] = fmt_trim_num(v, 4)
            else:
                row[jk] = fmt_money_billions(v)

        eps_track = series_by_key.get("epsActual")
        av_raw = lookup(eps_track, iso) if eps_track else None

        pct_n = None
        sp = lookup(surprise_pts, iso) if surprise_pts else None
        if sp is not None:
            pct_n = _eps_surprise_pct_normalize(sp)
            if pct_n == pct_n:  # not NaN
                row["epsSurprise"] = (("+" if pct_n >= 0 else "") + str(round(pct_n, 2)) + "%")
                if surprise_src:
                    row["epsSurpriseField"] = surprise_src

        row["epsEstimate"] = None
        est_f: float | None = None
        if estimate_pts:
            ev = lookup(estimate_pts, iso)
            if ev is not None:
                try:
                    est_f = float(ev)
                except Exception:
                    est_f = None
                if est_f is not None and abs(est_f) < 1e18:
                    row["epsEstimate"] = fmt_trim_num(est_f, 4)

        if row["epsEstimate"] is None and av_raw is not None and pct_n is not None and pct_n == pct_n:
            src_ok = surprise_src and (
                "PERCENT" in surprise_src.upper() or "PCT" in surprise_src.upper()
            )
            if src_ok and abs(pct_n) < 900:
                denom = 1.0 + (pct_n / 100.0)
                if abs(denom) > 1e-9:
                    est_f = float(av_raw) / denom
                    row["epsEstimate"] = fmt_trim_num(est_f, 4)

        row["beat"] = None
        if av_raw is not None and est_f is not None:
            row["beat"] = float(av_raw) >= float(est_f)

        anchor_val = lookup(anchor_pts, iso)
        anchor_iso = None
        if anchor_val is not None:
            anchor_iso = _bbelem_to_iso(anchor_val)
        anchor_for_px = anchor_iso if anchor_iso else iso
        row["anchorDateUsedForReaction"] = anchor_for_px
        row["historyRowSource"] = "bdh_legacy_union"
        if anchor_iso:
            row["reportOrAnnounceDate"] = anchor_iso
        if px_asc:
            row["stockReaction"] = reaction_bundle_for_anchor(px_asc, anchor_for_px, next_tim_hint)
        rows.append(row)
        if len(rows) >= 4:
            break
    return rows


def _build_quarter_rows(con, sec: str, next_tim_hint: str | None) -> list[dict]:
    """
    Prefer BDS EARN_ANN_DT_TIME_HIST_WITH_EPS (top 4) + BDH actual/estimate grid;
    fallback to legacy fiscal union if the grid is empty.
    """
    px = _load_daily_px_asc(con, sec)
    ann = _fetch_earn_ann_table(con, sec)
    grid = _fetch_quarterly_ae_surprise_grid(con, sec)
    if grid:
        return _merge_ann_into_grid(px, grid, ann, next_tim_hint)[:4]
    return _build_quarter_rows_legacy(con, sec, next_tim_hint)
    """Lightweight label for UI; not investment advice."""
    score = 0
    reasons = []
    de = d.get("debtToEquity")
    if isinstance(de, (int, float)):
        if de < 80:
            score += 1
            reasons.append("debt/equity moderate")
        elif de > 180:
            score -= 2
            reasons.append("high debt/equity")
    roe = d.get("returnOnEquity")
    if isinstance(roe, (int, float)):
        if roe > 15:
            score += 1
            reasons.append("ROE solid")
        elif roe < 5:
            score -= 1
            reasons.append("weak ROE")
    gm = d.get("grossMargins")
    om = d.get("operatingMargins")
    if isinstance(gm, (int, float)) and gm > 35:
        score += 1
        reasons.append("healthy gross margin")
    if isinstance(om, (int, float)) and om > 15:
        score += 1
        reasons.append("operating margin respectable")
    if isinstance(gm, (int, float)) and gm < 20:
        score -= 1
    cr = d.get("currentRatio")
    if isinstance(cr, (int, float)):
        if cr > 1.2:
            score += 1
            reasons.append("liquidity adequate")
        elif cr < 0.8:
            score -= 1
            reasons.append("tight liquidity")
    label = "Mixed"
    if score >= 3:
        label = "Strong"
    elif score <= -2:
        label = "Weak"
    elif score <= 0:
        label = "Moderate"
    elif score >= 1:
        label = "Solid"
    if not reasons:
        return None
    return {"label": label, "score": score, "reasons": reasons[:8]}


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


def _run_snapshot_refs(con, sec: str, sym: str) -> tuple[dict, int]:
    out: dict = {
        "bbSecurity": sec,
        "ticker": sym or sec.split()[0],
    }
    hits = 0
    for candidates, js_key in SAFE_SNAPSHOT_BB_FIELDS:
        v = ref_first_candidate(con, sec, list(candidates))
        if v is None:
            continue
        n = first_float(v)
        if n is not None:
            out[js_key] = n
            hits += 1
        else:
            ts = str(v).strip()
            if ts and ts.upper() != "N/A":
                out[js_key] = ts
                hits += 1
    qual = _financial_quality_hint(out)
    if qual:
        out["financialQualityHint"] = qual
    return out, hits


@app.get("/health")
def health():
    numpy_meta: dict = {}
    try:
        import numpy as _np

        numpy_meta["numpy_version"] = getattr(_np, "__version__", "unknown")
        # NaN == NaN is False in Python; test access for pdblp compatibility (np.NaN on NumPy 2).
        try:
            getattr(_np, "NaN")
            numpy_meta["numpy_NaN_attr"] = True
        except Exception:
            numpy_meta["numpy_NaN_attr"] = False
    except Exception as exc:
        numpy_meta["numpy_version"] = "error"
        numpy_meta["numpy_error"] = str(exc)

    out = {
        "ok": True,
        "bridge_build": BRIDGE_BUILD,
        **numpy_meta,
        "pdblp_installed": BCon is not None,
        "listen": "http://%s:%s" % (BRIDGE_BIND, PORT),
        "routes": ["/health", "/snapshot", "/earnings"],
        "hint_url_other_pc": None
        if BRIDGE_BIND == "127.0.0.1"
        else "http://%s:%s" % (_guess_lan_ip(), PORT),
    }
    if BRIDGE_BIND == "127.0.0.1":
        out["tunnel_hint"] = (
            "Public URL is not shown here. Run ngrok (or similar) forwarding to 127.0.0.1:%s. "
            "hint_url_other_pc is only set when BRIDGE_BIND is not 127.0.0.1 (LAN access)."
            % PORT
        )
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
        return jsonify(
            {"error": "unauthorized", "hint": "Authorization: Bearer <exact BLOOMBERG_BRIDGE_SECRET>; CMD: curl.exe ^ before &"}
        ), 401
    sym = clean_bridge_symbol(request.args.get("symbol", ""))
    bb_arg = request.args.get("bb", "").strip()
    if not sym and not bb_arg:
        return jsonify({"error": "symbol or bb required"}), 400
    sec = map_to_bb_security(sym or bb_arg.split()[0], bb_arg or None)
    try:
        con = get_bcon()
    except Exception as e:
        return jsonify({"error": str(e), "bbSecurity": sec}), 503

    tried_reset = False
    while True:
        try:
            out, hits = _run_snapshot_refs(con, sec, sym)
            break
        except Exception as e:
            if tried_reset or not _exc_suggests_bloomberg_restart(e):
                return jsonify({"error": str(e), "bbSecurity": sec}), 503
            reset_bloomberg_connection()
            try:
                con = get_bcon()
            except Exception as e2:
                return jsonify({"error": str(e2), "bbSecurity": sec}), 503
            tried_reset = True

    if hits == 0 and (not tried_reset) and (" US Equity" in sec.upper()):
        reset_bloomberg_connection()
        tried_reset = True
        try:
            con = get_bcon()
            out, hits = _run_snapshot_refs(con, sec, sym)
        except Exception as e:
            return jsonify({"error": str(e), "bbSecurity": sec}), 503

    if hits == 0 and (not tried_reset) and (
        (" IN Equity" in sec.upper()) or (" HK Equity" in sec.upper())
    ):
        reset_bloomberg_connection()
        tried_reset = True
        try:
            con = get_bcon()
            out, hits = _run_snapshot_refs(con, sec, sym)
        except Exception as e:
            return jsonify({"error": str(e), "bbSecurity": sec}), 503

    if hits == 0:
        return jsonify({"error": "no data", "bbSecurity": sec}), 503

    return jsonify(out)


def _earnings_json_dict(con, sec: str, sym: str) -> dict:
    header: dict = {}
    for fld in EARN_HEADER_REF_FIELDS:
        v = ref_field_safe(con, sec, fld)
        if v is not None:
            header[fld] = v

    tm_raw_val = ref_first_candidate(con, sec, list(EXPECTED_REPORT_TIME_CANDIDATES))

    period_label = _bb_ref_str(header.get("EXPECTED_REPORT_PERIOD"))
    if not period_label:
        period_label = _bb_ref_str(
            ref_first_candidate(con, sec, list(EXPECTED_REPORT_PERIOD_CANDIDATES))
        )

    nxt_dt = header.get("EXPECTED_REPORT_DT")
    nxt_typ = header.get("EXPECTED_REPORT_TYP")

    next_iso = ""
    if nxt_dt is not None:
        try:
            if not pd.isna(nxt_dt):
                next_iso = pd.Timestamp(nxt_dt).strftime("%Y-%m-%d")
        except Exception:
            next_iso = _pandas_ts_to_iso(nxt_dt)

    earnings_time = _report_typ_to_ui(nxt_typ) or _classification_from_bb_time(tm_raw_val) or "during-market"

    px_asc_hint = []
    headline_reaction = None
    try:
        px_asc_hint = _load_daily_px_asc(con, sec)
        if px_asc_hint and next_iso:
            headline_reaction = reaction_bundle_for_anchor(px_asc_hint, next_iso, earnings_time)
    except Exception as exc:
        if _session_dead(exc):
            raise
        headline_reaction = None

    est_from_best = fmt_trim_num(first_float(header.get("BEST_EPS")), 4)

    fq = ""
    ffq_txt = header.get("BEST_FFQ")
    if ffq_txt is not None:
        fts = str(ffq_txt).strip()
        if fts and fts.upper() != "N/A":
            fq = fts
    fped = header.get("BEST_FPERIOD_END_DT")
    if fped is not None:
        fq_iso = _pandas_ts_to_iso(fped)
        if fq_iso:
            try:
                tail = datetime.strptime(fq_iso, "%Y-%m-%d").strftime("%b %d, %Y")
                fq = fq + (" · " if fq else "") + "period end %s" % tail
            except Exception:
                fq = fq + (" · " if fq else "") + fq_iso

    if not fq and period_label:
        fq = period_label

    rev_est = fmt_money_billions(first_float(header.get("BEST_SALES")))
    ebd_est = fmt_money_billions(first_float(header.get("BEST_EBITDA")))
    ni_est = fmt_money_billions(first_float(header.get("BEST_NET_INCOME")))

    hist = []
    try:
        hist = _build_quarter_rows(con, sec, earnings_time)
    except Exception as exc:
        if _session_dead(exc):
            raise
        hist = []

    return {
        "bbSecurity": sec,
        "ticker": sym or sec.split()[0],
        "nextEarningsDate": next_iso or None,
        "epsEstimate": est_from_best,
        "consensusEstimatesHint": (
            {}
            if (rev_est is None and ebd_est is None and ni_est is None)
            else {
                "revenueConsensus": rev_est,
                "ebitdaConsensus": ebd_est,
                "netIncomeConsensus": ni_est,
            }
        ),
        "earningsTime": earnings_time,
        "postEventPriceHintNext": headline_reaction,
        "primaryStockReactionInterpretationHint": earnings_time or "during-market",
        "quarter": fq or None,
        "history": hist,
        "calendarPrimarySource": "bloomberg_bridge",
        "expectedReportTyp": _bb_ref_str(nxt_typ),
        "expectedReportPeriod": period_label,
        "expectedReportTime": _bb_ref_str(tm_raw_val),
        "sourcesNote": (
            "/earnings history prefers BDS "
            + EARN_ANN_BULK_FIELD
            + " (4 rows) for announcement dates/Bef-/Aft-mkt, "
            + "BDH AE=A|E-style EPS/revenue grids for actual vs consensus and computed surprise %%, "
            + "and PX_LAST close windows matching Excel BQL (Aft-mkt vs Bef-mkt). "
            + "Fallback: legacy quarterly BDH merge. Yahoo/FMP on server can still overlay gaps."
        ),
    }


@app.get("/earnings")
def earnings():
    if not check_secret():
        return jsonify(
            {"error": "unauthorized", "hint": "Authorization: Bearer <exact BLOOMBERG_BRIDGE_SECRET>; CMD: curl.exe ^ before &"}
        ), 401
    sym = clean_bridge_symbol(request.args.get("symbol", ""))
    bb_arg = request.args.get("bb", "").strip()
    if not sym and not bb_arg:
        return jsonify({"error": "symbol or bb required"}), 400
    sec = map_to_bb_security(sym or bb_arg.split()[0], bb_arg or None)

    tried_reset = False
    while True:
        try:
            con = get_bcon()
            return jsonify(_earnings_json_dict(con, sec, sym))
        except Exception as e:
            if tried_reset or not _exc_suggests_bloomberg_restart(e):
                return jsonify({"error": str(e), "bbSecurity": sec}), 503
            reset_bloomberg_connection()
            tried_reset = True


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
