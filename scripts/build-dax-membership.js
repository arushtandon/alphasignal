'use strict';

// Research data only. Changes are the DAX rows in the STOXX historical
// composition file, plus the 22 June 2026 DAX change. Share-class rolls that
// keep the same Yahoo symbol are not membership changes.
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'research', 'index-membership', 'dax.json');
const PRICE = path.join(ROOT, 'data', 'research', 'strategy-amendment-prices');
const PERIOD1 = 631152000;

const START = [
  'ADS.DE', 'ALV.DE', 'BAS.DE', 'BAYN.DE', 'BEI.DE', 'BMW.DE', 'CBK.DE', 'MBG.DE',
  'DBK.DE', 'DB1.DE', 'DHL.DE', 'DTE.DE', 'EOAN.DE', 'FRE.DE', 'FME.DE', 'HEN3.DE',
  'IFX.DE', 'SDF.DE', 'LIN.DE', 'LHA.DE', 'MAN.DE', 'MRK.DE', 'MEO.DE', 'MUV2.DE',
  'RWE.DE', 'SZG.DE', 'SAP.DE', 'SIE.DE', 'TKA.DE', 'VOW3.DE',
];

const CHANGES = [
  ['2010-06-21', 'HEI.DE', 'SZG.DE', 'HeidelbergCement replaces Salzgitter'],
  ['2012-09-24', 'LXS.DE', 'MAN.DE', 'Lanxess replaces MAN'],
  ['2012-09-24', 'CON.DE', 'MEO.DE', 'Continental replaces Metro'],
  ['2015-09-21', 'VNA.DE', 'LXS.DE', 'Vonovia replaces Lanxess'],
  ['2016-03-21', 'PSM.DE', 'SDF.DE', 'ProSiebenSat.1 replaces K+S'],
  ['2018-03-19', '1COV.DE', 'PSM.DE', 'Covestro replaces ProSiebenSat.1'],
  ['2018-09-24', 'WDI.DE', 'CBK.DE', 'Wirecard replaces Commerzbank'],
  ['2019-09-23', 'MTX.DE', 'TKA.DE', 'MTU replaces Thyssenkrupp'],
  ['2020-06-22', 'DWNI.DE', 'LHA.DE', 'Deutsche Wohnen replaces Lufthansa'],
  ['2020-08-24', 'DHER.DE', 'WDI.DE', 'Delivery Hero replaces Wirecard'],
  ['2021-03-22', 'ENR.DE', 'BEI.DE', 'Siemens Energy replaces Beiersdorf'],
  ['2021-09-20', 'AIR.DE', null, 'DAX expansion'],
  ['2021-09-20', 'BNR.DE', null, 'DAX expansion'],
  ['2021-09-20', 'HFG.DE', null, 'DAX expansion'],
  ['2021-09-20', 'PAH3.DE', null, 'DAX expansion'],
  ['2021-09-20', 'PUM.DE', null, 'DAX expansion'],
  ['2021-09-20', 'QIA.DE', null, 'DAX expansion'],
  ['2021-09-20', 'SRT3.DE', null, 'DAX expansion'],
  ['2021-09-20', 'SHL.DE', null, 'DAX expansion'],
  ['2021-09-20', 'SY1.DE', null, 'DAX expansion'],
  ['2021-09-20', 'ZAL.DE', null, 'DAX expansion'],
  ['2021-10-29', 'BEI.DE', 'DWNI.DE', 'Beiersdorf replaces Deutsche Wohnen'],
  ['2022-03-21', 'DTG.DE', 'BEI.DE', 'Daimler Truck replaces Beiersdorf'],
  ['2022-03-21', 'HNR1.DE', 'ENR.DE', 'Hannover Re replaces Siemens Energy'],
  ['2022-06-20', 'BEI.DE', 'DHER.DE', 'Beiersdorf replaces Delivery Hero'],
  ['2022-09-19', 'ENR.DE', 'HFG.DE', 'Siemens Energy replaces HelloFresh'],
  ['2022-12-19', 'P911.DE', 'PUM.DE', 'Porsche AG replaces Puma'],
  ['2023-02-27', 'CBK.DE', 'LIN.DE', 'Commerzbank replaces Linde'],
  ['2023-03-20', 'RHM.DE', 'FME.DE', 'Rheinmetall replaces Fresenius Medical Care'],
  ['2024-12-27', 'FME.DE', '1COV.DE', 'Fresenius Medical Care replaces Covestro'],
  ['2025-09-22', 'G1A.DE', 'SRT3.DE', 'GEA replaces Sartorius pref'],
  ['2025-09-22', 'G24.DE', 'P911.DE', 'Scout24 replaces Porsche AG'],
  ['2026-06-22', 'HOT.DE', 'PAH3.DE', 'Hochtief replaces Porsche Automobil Holding'],
];

function apply(start, changes) {
  const members = new Set(start);
  for (const [, added, removed] of changes) {
    if (removed) members.delete(removed);
    if (added) members.add(added);
  }
  return [...members].sort();
}

function yahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${PERIOD1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  return new Promise(resolve => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body)?.chart?.result?.[0];
          const stamps = result?.timestamp || [];
          const quote = result?.indicators?.quote?.[0] || {};
          const bars = [];
          for (let index = 0; index < stamps.length; index += 1) {
            if (!(quote.close?.[index] > 0)) continue;
            bars.push({
              t: stamps[index],
              o: quote.open?.[index] || quote.close[index],
              h: quote.high?.[index] || quote.close[index],
              l: quote.low?.[index] || quote.close[index],
              c: quote.close[index],
            });
          }
          resolve(bars);
        } catch (_) { resolve([]); }
      });
    });
    request.on('error', () => resolve([]));
    request.setTimeout(20000, () => request.destroy());
  });
}

async function download(symbol) {
  const file = path.join(PRICE, `${symbol.replace(/[\\/]/g, '_')}.json`);
  if (fs.existsSync(file)) {
    const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars || [];
    return bars.length;
  }
  const bars = await yahooChart(symbol);
  if (bars.length) fs.writeFileSync(file, JSON.stringify({ bars }));
  return bars.length;
}

async function main() {
  const current = apply(START, CHANGES);
  if (START.length !== 30) throw new Error(`start ${START.length}`);
  const snapshot = {
    index: 'DAX',
    source: 'STOXX Historical Index Compositions of DAX Equity Indices (stoxx.com/document/Indices/Common/Indexguide/Historical_Index_Compositions.pdf, file dated 23 March 2026) for every DAX change from 21 June 2010 through 22 September 2025. The 22 June 2026 change is the DAX row in STOXX_Components_Changes_DAX_Blue_Chip_Indices_20260612.pdf (Hochtief in, Porsche Automobil Holding pref out). The 3 September 2026 STOXX review changed MDAX, SDAX and TecDAX and left the DAX unchanged. Deutsche Börse share-class rolls of Deutsche Börse (2016 and 2017) and Linde (2017) kept the same Yahoo symbol and are not membership changes. The 30 names on 1 January 2010 are the composition after the 23 December 2009 Volkswagen ordinary-to-preference change in that same STOXX file.',
    asOf: '2026-10-07',
    currentSymbols: current,
    historicalMembership: {
      available: true,
      changes: CHANGES.map(([date, added, removed, name]) => ({ date, added, removed, name })),
    },
  };
  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log('current', current.length);
  console.log(current.join(','));
  const ever = new Set(START);
  for (const [, added, removed] of CHANGES) {
    if (added) ever.add(added);
    if (removed) ever.add(removed);
  }
  const missing = [];
  for (const symbol of ever) {
    const count = await download(symbol);
    console.log(symbol, count || 'NO PRICE');
    if (!count) missing.push(symbol);
  }
  const ewg = await download('EWG');
  console.log('EWG', ewg || 'NO PRICE');
  console.log('missing', missing.join(',') || 'none');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
