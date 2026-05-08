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

Default: http://127.0.0.1:5055/snapshot?symbol=V

Point AlphaSignal at it (same machine as Terminal):
  set BLOOMBERG_BRIDGE_URL=http://127.0.0.1:5055
  optional: set BLOOMBERG_BRIDGE_SECRET=yourtoken
"""
from __future__ import annotations

import os
import re
import socket
import sys

from flask import Flask, jsonify, request

try:
    from pdblp import BCon
except ImportError:
    BCon = None  # type: ignore

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
    return jsonify(
        {
            "ok": True,
            "pdblp_installed": BCon is not None,
            "listen": "http://%s:%s" % (BRIDGE_BIND, PORT),
            "hint_url_other_pc": None
            if BRIDGE_BIND == "127.0.0.1"
            else "http://%s:%s" % (_guess_lan_ip(), PORT),
        }
    )


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
        print("ERROR: pip install pdblp   (Bloomberg Terminal required on this machine)", file=sys.stderr)
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
