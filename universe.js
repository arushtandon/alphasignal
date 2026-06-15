// universe.js — full index-constituent universe for the server-side daily scan.
//
// US indices (S&P 500, NASDAQ 100) are fetched LIVE from FMP at scan time so the
// list is always current. International indices are bundled here as constituent
// lists keyed to Yahoo Finance symbols (the format the OHLCV fetcher expects).
//
// Any ticker that fails to return OHLCV is simply skipped during the scan, so a
// stale/renamed name is harmless — it just doesn't produce a signal.

// ── International / non-US constituents (Yahoo symbols) ──────────────────────

const DAX = [
  'SAP.DE','SIE.DE','ALV.DE','DTE.DE','AIR.DE','MBG.DE','BMW.DE','MUV2.DE',
  'IFX.DE','BAS.DE','BAYN.DE','VOW3.DE','ADS.DE','DB1.DE','DBK.DE','RWE.DE',
  'EOAN.DE','MRK.DE','HEN3.DE','BEI.DE','DHL.DE','HNR1.DE','VNA.DE','SHL.DE',
  'FRE.DE','FME.DE','SY1.DE','CON.DE','MTX.DE','HEI.DE','PAH3.DE','QIA.DE',
  'CBK.DE','ZAL.DE','ENR.DE','RHM.DE','P911.DE','SRT3.DE','1COV.DE','BNR.DE'
];

const CAC40 = [
  'MC.PA','OR.PA','TTE.PA','SAN.PA','BNP.PA','AIR.PA','SU.PA','AI.PA',
  'EL.PA','CS.PA','DG.PA','KER.PA','RMS.PA','SGO.PA','BN.PA','HO.PA',
  'ACA.PA','CAP.PA','VIE.PA','ENGI.PA','DSY.PA','STLAP.PA','RI.PA','ML.PA',
  'PUB.PA','LR.PA','GLE.PA','EN.PA','SW.PA','ORA.PA','VIV.PA','CA.PA',
  'TEP.PA','ERF.PA','URW.PA','WLN.PA','STMPA.PA','EDEN.PA','RNO.PA','ALO.PA'
];

const FTSE100 = [
  'SHEL.L','AZN.L','HSBA.L','ULVR.L','BP.L','GSK.L','RIO.L','DGE.L','GLEN.L',
  'BATS.L','REL.L','LSEG.L','NG.L','RKT.L','BA.L','LLOY.L','VOD.L','BARC.L',
  'NWG.L','PRU.L','CPG.L','EXPN.L','AAL.L','ANTO.L','STAN.L','IMB.L','TSCO.L',
  'SSE.L','HLN.L','III.L','BT-A.L','AV.L','LGEN.L','SGRO.L','CRH.L','SMIN.L',
  'INF.L','WTB.L','ABF.L','SBRY.L','SN.L','MNDI.L','HLMA.L','FLTR.L','AHT.L',
  'CCH.L','RR.L','ITRK.L','BNZL.L','SPX.L','PSON.L','ADM.L','PHNX.L','SVT.L',
  'UU.L','RTO.L','WPP.L','DCC.L','JD.L','KGF.L','BDEV.L','PSN.L','TW.L',
  'LAND.L','BLND.L','UTG.L','HWDN.L','MRO.L','WEIR.L','SMT.L','FRES.L','EDV.L',
  'ENT.L','IHG.L','CNA.L','DPLM.L','MGGT.L','RMV.L','BKG.L','AUTO.L','HIK.L',
  'CTEC.L','PSH.L','BME.L','CCEP.L','EZJ.L','OCDO.L','STJ.L','MNG.L','ICG.L',
  'BEZ.L','VTY.L','DLG.L','FCIT.L','HSX.L','GAW.L','TATE.L','LMP.L','FOUR.L','SDR.L'
];

const NIFTY50 = [
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','ICICIBANK.NS','INFY.NS','HINDUNILVR.NS',
  'ITC.NS','SBIN.NS','BHARTIARTL.NS','KOTAKBANK.NS','LT.NS','AXISBANK.NS',
  'ASIANPAINT.NS','MARUTI.NS','SUNPHARMA.NS','TITAN.NS','WIPRO.NS','ULTRACEMCO.NS',
  'ONGC.NS','NTPC.NS','POWERGRID.NS','NESTLEIND.NS','M&M.NS','BAJFINANCE.NS',
  'HCLTECH.NS','TECHM.NS','DRREDDY.NS','DIVISLAB.NS','CIPLA.NS','BAJAJFINSV.NS',
  'TATAMOTORS.NS','TATASTEEL.NS','JSWSTEEL.NS','HINDALCO.NS','COALINDIA.NS',
  'BPCL.NS','GRASIM.NS','ADANIPORTS.NS','ADANIENT.NS','INDUSINDBK.NS',
  'EICHERMOT.NS','APOLLOHOSP.NS','BAJAJ-AUTO.NS','BRITANNIA.NS','HEROMOTOCO.NS',
  'SBILIFE.NS','HDFCLIFE.NS','SHRIRAMFIN.NS','LTIM.NS','TATACONSUM.NS'
];

const HSI = [
  '0700.HK','9988.HK','0005.HK','1299.HK','0939.HK','1398.HK','3690.HK',
  '9999.HK','2318.HK','0388.HK','0001.HK','2020.HK','9618.HK','2269.HK',
  '3988.HK','0941.HK','0883.HK','0386.HK','0688.HK','1109.HK','2007.HK',
  '1093.HK','1177.HK','2331.HK','2382.HK','0027.HK','0011.HK','0016.HK',
  '0017.HK','0066.HK','0083.HK','0101.HK','0175.HK','0241.HK','0267.HK',
  '0288.HK','0291.HK','0316.HK','0322.HK','0669.HK','0762.HK','0823.HK',
  '0857.HK','0868.HK','0960.HK','0968.HK','0981.HK','0992.HK','1038.HK',
  '1044.HK','1088.HK','1113.HK','1209.HK','1211.HK','1378.HK','1810.HK',
  '1876.HK','1928.HK','1929.HK','1997.HK','2015.HK','2313.HK','2319.HK',
  '2359.HK','2628.HK','2688.HK','3692.HK','3968.HK','6098.HK','6618.HK',
  '6690.HK','6862.HK','9633.HK','9888.HK','9961.HK','9901.HK','1024.HK','9626.HK'
];

// Nikkei 225 — best-effort full constituent set (Yahoo .T codes).
const NIKKEI225 = [
  '7203.T','6758.T','9984.T','6861.T','8306.T','4519.T','6954.T','7974.T',
  '6902.T','9432.T','8035.T','4063.T','2914.T','6501.T','4661.T','9433.T',
  '6098.T','8058.T','8001.T','8031.T','8053.T','8002.T','6981.T','6367.T',
  '6273.T','6857.T','7741.T','4543.T','4503.T','4502.T','4523.T','4568.T',
  '4151.T','4507.T','4578.T','4901.T','3407.T','4188.T','4005.T','4061.T',
  '4042.T','4183.T','5108.T','5401.T','5411.T','5713.T','5802.T','5803.T',
  '3402.T','3405.T','5019.T','5020.T','1605.T','1925.T','1928.T','1802.T',
  '1801.T','1803.T','1812.T','5631.T','7011.T','7012.T','7013.T','6326.T',
  '6301.T','6305.T','6471.T','6472.T','6473.T','7951.T','7731.T','7733.T',
  '7752.T','4902.T','6752.T','6753.T','6645.T','6770.T','6701.T','6702.T',
  '6504.T','6506.T','6532.T','6594.T','6724.T','6762.T','6841.T','6920.T',
  '6952.T','6963.T','6971.T','6976.T','6988.T','7735.T','8035.T','3436.T',
  '4062.T','7203.T','7201.T','7202.T','7211.T','7261.T','7267.T','7269.T',
  '7270.T','7272.T','7205.T','5108.T','3861.T','3863.T','7912.T','7911.T',
  '4324.T','9602.T','9613.T','9719.T','2432.T','4755.T','4385.T','4751.T',
  '6178.T','9437.T','9434.T','9613.T','4704.T','3659.T','2371.T','6098.T',
  '8604.T','8601.T','8473.T','8628.T','8411.T','8316.T','8309.T','8308.T',
  '8331.T','8354.T','8355.T','7186.T','8253.T','8591.T','8697.T','8766.T',
  '8725.T','8750.T','8795.T','8630.T','8804.T','8801.T','8802.T','8830.T',
  '3289.T','8233.T','8252.T','3099.T','8267.T','2802.T','2502.T','2503.T',
  '2531.T','2801.T','2871.T','2269.T','2282.T','2002.T','2587.T','3382.T',
  '9983.T','8267.T','7453.T','3092.T','9843.T','9831.T','2730.T','8233.T',
  '9501.T','9502.T','9503.T','9531.T','9532.T','9020.T','9021.T','9022.T',
  '9001.T','9005.T','9007.T','9008.T','9009.T','9064.T','9101.T','9104.T',
  '9107.T','9147.T','9201.T','9202.T','9301.T','9302.T','9412.T','9613.T',
  '9735.T','9766.T','4689.T','4324.T','2413.T','6178.T','4307.T','9744.T',
  '6479.T','6645.T','6113.T','6103.T','6361.T','7004.T','7003.T','7012.T',
  '7911.T','3401.T','3402.T','4631.T','4208.T','4118.T','4021.T','4043.T',
  '3105.T','3861.T','5232.T','5233.T','5301.T','5333.T','5332.T','5631.T',
  '5706.T','5711.T','5714.T','5801.T','3436.T','5901.T','5938.T','5991.T'
];

const COMMODITIES = [
  'GC=F','SI=F','BZ=F','CL=F','NG=F','HG=F','PL=F','PA=F',
  'BTC-USD','ETH-USD'
];

// US fallback core (used only if the FMP constituent fetch fails).
const US_CORE = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','BRK-B','AVGO',
  'LLY','JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','NFLX','ABBV',
  'CRM','BAC','ORCL','MRK','CVX','KO','AMD','PEP','ADBE','WMT','TMO','MCD',
  'CSCO','ACN','ABT','LIN','INTC','QCOM','TXN','DIS','IBM','GE','CAT','GS',
  'MS','INTU','AMAT','MU','LRCX','KLAC','PANW','SNPS','CDNS','CRWD','FTNT',
  'MRVL','ON','BKNG','ISRG','NOW','UBER','PYPL','SBUX','GILD','REGN','VRTX'
];

const MARKET_LABEL = {
  US: 'US (S&P 500 / NASDAQ 100)',
  DAX: 'DAX',
  CAC40: 'CAC 40',
  FTSE100: 'FTSE 100',
  NIFTY50: 'Nifty 50',
  HSI: 'Hang Seng',
  NIKKEI225: 'Nikkei 225',
  COMMODITIES: 'Commodities & Crypto'
};

/** Map an FMP US symbol (e.g. "BRK.B") to its Yahoo form ("BRK-B"). */
function fmpToYahooUS(sym) {
  return String(sym || '').trim().toUpperCase().replace(/\./g, '-');
}

/**
 * Fetch S&P 500 + NASDAQ 100 constituents from FMP, mapped to Yahoo symbols.
 * Returns a de-duplicated array of US tickers, or US_CORE on failure.
 *
 * @param {Function} fetchFn  global fetch (passed in to avoid import coupling)
 * @param {string}   fmpKey   FMP api key (falsy → fallback list)
 */
async function fetchUSConstituents(fetchFn, fmpKey) {
  if (!fmpKey || typeof fetchFn !== 'function') return [...US_CORE];
  const k = encodeURIComponent(fmpKey);
  // FMP migrated constituents to the hyphenated /stable path; legacy /api/v3
  // underscored endpoints still work on some plans. Try both per index and use
  // whichever returns a usable array.
  const indexEndpoints = [
    [ // S&P 500
      `https://financialmodelingprep.com/stable/sp500-constituent?apikey=${k}`,
      `https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${k}`
    ],
    [ // NASDAQ 100
      `https://financialmodelingprep.com/stable/nasdaq-constituent?apikey=${k}`,
      `https://financialmodelingprep.com/api/v3/nasdaq_constituent?apikey=${k}`
    ]
  ];
  const out = new Set();
  for (const candidates of indexEndpoints) {
    for (const url of candidates) {
      try {
        const r = await fetchFn(url);
        if (!r || !r.ok) continue;
        const j = await r.json();
        if (!Array.isArray(j) || !j.length) continue; // error object → try next
        for (const row of j) {
          const s = fmpToYahooUS(row && row.symbol);
          if (s) out.add(s);
        }
        break; // this index resolved — move to the next index
      } catch (_) { /* try next candidate */ }
    }
  }
  if (out.size < 50) return [...US_CORE]; // both failed → fallback
  return [...out];
}

/**
 * Build the full scan universe. Returns an array of
 * { t: yahooSymbol, market: marketKey } with duplicates removed
 * (first market wins for a given ticker).
 */
async function buildFullUniverse(fetchFn, fmpKey) {
  const us = await fetchUSConstituents(fetchFn, fmpKey);
  const groups = [
    ['US', us],
    ['DAX', DAX],
    ['CAC40', CAC40],
    ['FTSE100', FTSE100],
    ['NIFTY50', NIFTY50],
    ['HSI', HSI],
    ['NIKKEI225', NIKKEI225],
    ['COMMODITIES', COMMODITIES]
  ];
  const seen = new Set();
  const universe = [];
  for (const [market, list] of groups) {
    for (const raw of list) {
      const t = String(raw || '').trim().toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      universe.push({ t, market });
    }
  }
  return universe;
}

module.exports = {
  buildFullUniverse,
  fetchUSConstituents,
  MARKET_LABEL,
  US_CORE,
  STATIC_GROUPS: { DAX, CAC40, FTSE100, NIFTY50, HSI, NIKKEI225, COMMODITIES }
};
