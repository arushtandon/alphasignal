'use strict';

// Research only. Builds point-in-time FTSE 100 and CAC 40 membership from
// public index-change records. Does not change live orders.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const FTSE_TEXT = path.join(DIR, 'ftse-100-constituent-history.txt');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function norm(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function isoFromFtse(text) {
  const match = String(text).trim().match(/^(\d{1,2})\s*-?\s*([A-Za-z]{3})\s*-?\s*(\d{2})$/)
    || String(text).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[3]);
  const full = year >= 70 ? 1900 + year : 2000 + year;
  const month = MONTHS[match[2].toLowerCase()];
  return `${full}-${String(month).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
}
function isoFromDmy(text) {
  const match = String(text).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}
function yahooLondon(ticker) {
  return `${String(ticker).trim().toUpperCase().replace(/\./g, '-')}.L`;
}

const FTSE_CURRENT = [
  'III', 'ABDN', 'ADM', 'AAF', 'ALW', 'AAL', 'ANTO', 'ABF', 'AZN', 'AUTO', 'AV', 'BAB', 'BA', 'BBY',
  'BARC', 'BTRW', 'BP', 'BATS', 'BLND', 'BT.A', 'BNZL', 'BRBY', 'CNA', 'CCEP', 'CCH', 'CPG', 'CCC',
  'CTEC', 'CRDA', 'DCC', 'DGE', 'DPLM', 'EZJ', 'EDV', 'EXPN', 'FCIT', 'FRES', 'GAW', 'GLEN', 'GSK',
  'HLN', 'HLMA', 'HSX', 'HWDN', 'HSBA', 'ICG', 'IGG', 'IHG', 'IMI', 'IMB', 'INF', 'IAG', 'ITRK',
  'INVP', 'ITH', 'JD', 'BGEO', 'KGF', 'LAND', 'LGEN', 'LLOY', 'LMP', 'LSEG', 'MNG', 'MKS', 'MRO',
  'MTLN', 'NG', 'NWG', 'NXT', 'PSON', 'PSH', 'PCT', 'PRU', 'RKT', 'REL', 'RTO', 'RIO', 'RR', 'SGE',
  'SBRY', 'SMT', 'SGRO', 'SVT', 'SHEL', 'SMIN', 'SN', 'SPX', 'SSE', 'STAN', 'SDLF', 'STJ', 'TSCO',
  'BBOX', 'ULVR', 'UU', 'VOD', 'WEIR', 'WTB', 'WPP',
].map(yahooLondon);

const FTSE_NAMES = {
  '3i group': 'III.L',
  'arm holdings': 'ARM.L',
  'aberdeen asset management': 'ABDN.L',
  'aberdeen group': 'ABDN.L',
  'abrdn': 'ABDN.L',
  'african barrick gold': 'ABG.L',
  'aggreko': 'AGK.L',
  'airtel africa': 'AAF.L',
  'alliance trust': 'ATST.L',
  'alliance witan': 'ALW.L',
  'amec': 'AMEC.L',
  'ashmore group': 'ASHM.L',
  'ashtead group': 'AHT.L',
  'auto trader group': 'AUTO.L',
  'autonomy corporation': 'AU.L',
  'avast': 'AVST.L',
  'aveva group': 'AVV.L',
  'b and m european value retail': 'BME.L',
  'b8m european value retail': 'BME.L',
  'bg group': 'BG.L',
  'bhp group plc': 'BHP.L',
  'babcock international group': 'BAB.L',
  'barratt developments': 'BTRW.L',
  'beazley': 'BEZ.L',
  'berkeley group holdings': 'BKG.L',
  'british land co': 'BLND.L',
  'british land co.': 'BLND.L',
  'bunzl': 'BNZL.L',
  'burberry group': 'BRBY.L',
  'crh': 'CRH.L',
  'cable and wireless worldwide': 'CWW.L',
  'cairn energy': 'CNE.L',
  'capita': 'CPI.L',
  'carnival': 'CCL.L',
  'centrica': 'CNA.L',
  'cobham': 'COB.L',
  'coca cola europacific partners': 'CCEP.L',
  'coca cola hbc ag': 'CCH.L',
  'computacenter': 'CCC.L',
  'convatec group': 'CTEC.L',
  'croda international': 'CRDA.L',
  'dcc': 'DCC.L',
  'darktrace': 'DARK.L',
  'dechra pharmaceuticals': 'DPH.L',
  'diploma': 'DPLM.L',
  'direct line insurance group': 'DLG.L',
  'dixons carphone': 'DC.L',
  'dowlais group': 'DWL.L',
  'easyjet': 'EZJ.L',
  'electrocomponents': 'RS1.L',
  'endeavour mining': 'EDV.L',
  'essar energy': 'ESSR.L',
  'eurasian natural resources corporation': 'ENRC.L',
  'evraz': 'EVR.L',
  'f and c investment trust': 'FCIT.L',
  'ferguson': 'FERG.L',
  'flutter entertainment': 'FLTR.L',
  'frasers group': 'FRAS.L',
  'fresnillo': 'FRES.L',
  'friends life group': 'FLG.L',
  'g4s': 'GFS.L',
  'gkn': 'GKN.L',
  'gvc holdings': 'ENT.L',
  'games workshop group': 'GAW.L',
  'glencore': 'GLEN.L',
  'haleon': 'HLN.L',
  'halma': 'HLMA.L',
  'hammerson': 'HMSO.L',
  'harbour energy': 'HBR.L',
  'hargreaves lansdown': 'HL.L',
  'hikma pharmaceuticals': 'HIK.L',
  'hiscox': 'HSX.L',
  'home retail group': 'HOME.L',
  'homeserve': 'HSV.L',
  'howden joinery group': 'HWDN.L',
  'icap': 'IAP.L',
  'ig group holdings': 'IGG.L',
  'imi': 'IMI.L',
  'itv': 'ITV.L',
  'informa': 'INF.L',
  'inmarsat': 'ISAT.L',
  'intermediate capital group': 'ICG.L',
  'intermediate capital grup': 'ICG.L',
  'international power': 'IPR.L',
  'intu properties': 'INTU.L',
  'invensys': 'ISYS.L',
  'investec': 'INVP.L',
  'jd sports fashion': 'JD.L',
  'johnson matthey': 'JMAT.L',
  'just eat': 'JET.L',
  'just eat takeaway com': 'JET.L',
  'just eat takeaway com star': 'JET.L',
  'kazakhmys': 'KAZ.L',
  'kingfisher': 'KGF.L',
  'lion finance group': 'BGEO.L',
  'london stock exchange group': 'LSEG.L',
  'londonmetric property': 'LMP.L',
  'lonmin': 'LMI.L',
  'man group': 'EMG.L',
  'marks and spencer group': 'MKS.L',
  'mediclinic international': 'MDC.L',
  'mediclinic international plc': 'MDC.L',
  'meggitt': 'MGGT.L',
  'melrose': 'MRO.L',
  'melrose industries': 'MRO.L',
  'merlin entertainments': 'MERL.L',
  'metlen energy and metals': 'MTLN.L',
  'micro focus international': 'MCRO.L',
  'mondi': 'MNDI.L',
  'morrison': 'MRW.L',
  'morrison wm supermarkets': 'MRW.L',
  'nmc health': 'NMC.L',
  'ocado group': 'OCDO.L',
  'old mutual': 'OML.L',
  'paddy power betfair': 'FLTR.L',
  'pennon group': 'PNN.L',
  'pershing square holdings': 'PSH.L',
  'persimmon': 'PSN.L',
  'petrofac': 'PFC.L',
  'phoenix group holdings': 'PHNX.L',
  'polar capital technology trust': 'PCT.L',
  'polymetal': 'POLY.L',
  'polymetal international': 'POLY.L',
  'provident financial': 'PFG.L',
  'rs group': 'RS1.L',
  'rsa insurance group': 'RSA.L',
  'randgold resources': 'RRS.L',
  'reinshaw': 'RSW.L',
  'renishaw': 'RSW.L',
  'rentokil initial': 'RTO.L',
  'resolution': 'RSL.L',
  'rexam': 'REX.L',
  'rightmove': 'RMV.L',
  'royal dutch shell b': 'RDSB.L',
  'royal mail': 'RMG.L',
  'scottish mortgage investment trust': 'SMT.L',
  'seagro': 'SGRO.L',
  'segro': 'SGRO.L',
  'serco group': 'SRP.L',
  'shire': 'SHP.L',
  'sky': 'SKY.L',
  'smith ds': 'SMDS.L',
  'smiths group': 'SMIN.L',
  'smufit kappa group': 'SKG.L',
  'smurfit kappa group': 'SKG.L',
  'spirax sarco engineering': 'SPX.L',
  'sports direct international': 'FRAS.L',
  'st james s place': 'STJ.L',
  'tui ag': 'TUI.L',
  'tui travel': 'TT.L',
  'tate and lyle': 'TATE.L',
  'taylor wimpey': 'TW.L',
  'thomas cook group': 'TCG.L',
  'thungela resources': 'TGA.L',
  'tomkins': 'TOMK.L',
  'travis perkins': 'TPK.L',
  'tritax big box reit': 'BBOX.L',
  'tullow oil': 'TLW.L',
  'unite group': 'UTG.L',
  'vedanta resources': 'VED.L',
  'vistry group': 'VTY.L',
  'wpp': 'WPP.L',
  'weir group': 'WEIR.L',
  'william hill': 'WMH.L',
  'wood group john': 'WG.L',
  'worldpay group': 'WPG.L',
};

const TEMPORARY = new Set([
  'valterra platinum distribution line',
  'the magnum ice cream company',
  'jackson financial dummy line',
].map(norm));

function parseFtse() {
  const lines = fs.readFileSync(FTSE_TEXT, 'utf8').split(/\r?\n/);
  const events = [];
  let current = null;
  let columns = null;
  const take = (line, start, end) => (line.slice(start, end) || '').trim();
  for (const raw of lines) {
    const line = raw.replace(/\f/g, '');
    if (/^\s*Date\s+Added/.test(line)) {
      if (current) events.push(current);
      current = null;
      columns = { added: line.indexOf('Added'), deleted: line.indexOf('Deleted'), notes: line.indexOf('Notes') };
      continue;
    }
    if (!columns || /FTSE Russell|FTSE 100 Historic/.test(line) || !line.trim()) {
      if (!line.trim() && current) { events.push(current); current = null; }
      continue;
    }
    const dated = line.match(/^\s*(\d{1,2}\s*-\s*[A-Za-z]{3}-\d{2}|\d{1,2}\s+[A-Za-z]{3}-\d{2})/);
    if (dated) {
      if (current) events.push(current);
      current = {
        date: isoFromFtse(dated[1].replace(/\s+/g, '')),
        added: take(line, columns.added, columns.deleted),
        deleted: take(line, columns.deleted, columns.notes),
      };
      continue;
    }
    if (!current) continue;
    current.added = `${current.added} ${take(line, columns.added, columns.deleted)}`.replace(/\s+/g, ' ').trim();
    current.deleted = `${current.deleted} ${take(line, columns.deleted, columns.notes)}`.replace(/\s+/g, ' ').trim();
  }
  if (current) events.push(current);
  const unmapped = [];
  const changes = [];
  for (const event of events) {
    if (!event.date || event.date < '2010-01-01') continue;
    for (const side of ['added', 'deleted']) {
      const name = event[side];
      if (!name || norm(name).length < 2) continue;
      const key = norm(name).replace(/\s+star$/, '');
      if (TEMPORARY.has(key) || TEMPORARY.has(norm(name))) continue;
      const symbol = FTSE_NAMES[key] || FTSE_NAMES[norm(name)];
      if (!symbol) { unmapped.push(`${event.date} ${side} ${name}`); continue; }
      changes.push({ date: event.date, [side === 'added' ? 'added' : 'removed']: symbol, name });
    }
  }
  return { changes, unmapped };
}

// Euronext notices as compiled by the public CAC 40 change archive
// (bnains.org/archives/histocac), from 2010. A few printed row dates disagree
// with the notice text; the session date in the notice is used and noted.
const CAC_CHANGES = [
  ['2010-07-02', 'added', 'EDEN.PA'],
  ['2010-07-05', 'removed', 'EDEN.PA'],
  ['2010-09-20', 'removed', 'DXB.BR'],
  ['2010-09-20', 'added', 'KN.PA'],
  ['2010-09-20', 'removed', 'MMB.PA'],
  ['2010-09-20', 'added', 'PUB.PA'],
  ['2011-09-16', 'removed', 'KN.PA'],
  ['2011-09-19', 'added', 'SAF.PA'],
  ['2011-12-16', 'removed', 'SEV.PA'],
  ['2011-12-19', 'added', 'LR.PA'],
  ['2012-09-21', 'removed', 'UG.PA'],
  ['2012-09-24', 'added', 'SOLB.BR'],
  ['2012-12-21', 'removed', 'ALU.PA'],
  ['2012-12-24', 'added', 'GTO.PA'],
  ['2013-12-20', 'removed', 'STMPA.PA'],
  ['2013-12-23', 'added', 'ALU.PA'],
  ['2014-06-18', 'removed', 'VK.PA'],
  ['2014-06-21', 'added', 'FR.PA'],
  ['2015-03-18', 'removed', 'GTO.PA'],
  ['2015-03-21', 'added', 'UG.PA'],
  ['2015-12-18', 'removed', 'EDF.PA'],
  ['2015-12-21', 'added', 'LI.PA'],
  ['2016-01-06', 'removed', 'ALU.PA'],
  ['2016-01-07', 'added', 'NOKIA.PA'],
  ['2016-03-18', 'removed', 'ALO.PA'],
  ['2016-03-21', 'added', 'SW.PA'],
  ['2017-03-20', 'removed', 'LI.PA'],
  ['2017-03-20', 'added', 'ATO.PA'],
  ['2017-09-18', 'removed', 'NOKIA.PA'],
  ['2017-09-18', 'added', 'STMPA.PA'],
  ['2018-06-18', 'removed', 'LHN.PA'],
  ['2018-06-18', 'added', 'RMS.PA'],
  ['2018-09-24', 'removed', 'SOLB.BR'],
  ['2018-09-24', 'added', 'DSY.PA'],
  ['2019-05-03', 'added', 'WLN.PA'],
  ['2019-06-24', 'removed', 'WLN.PA'],
  ['2019-06-24', 'removed', 'FR.PA'],
  ['2019-06-24', 'added', 'HO.PA'],
  ['2020-03-23', 'removed', 'FTI.PA'],
  ['2020-03-23', 'added', 'WLN.PA'],
  ['2020-06-22', 'removed', 'SW.PA'],
  ['2020-06-22', 'added', 'TEP.PA'],
  ['2020-09-21', 'removed', 'AC.PA'],
  ['2020-09-21', 'added', 'ALO.PA'],
  ['2021-01-15', 'removed', 'UG.PA'],
  ['2021-01-18', 'added', 'STLAP.PA'],
  ['2021-09-17', 'removed', 'ATO.PA'],
  ['2021-09-20', 'added', 'ERF.PA'],
  ['2023-06-16', 'removed', 'VIV.PA'],
  ['2023-06-19', 'added', 'EDEN.PA'],
  ['2023-12-15', 'removed', 'WLN.PA'],
  ['2023-12-18', 'added', 'VIV.PA'],
  ['2024-03-15', 'removed', 'ALO.PA'],
  ['2024-03-18', 'added', 'AC.PA'],
  ['2024-12-20', 'removed', 'VIV.PA'],
  ['2024-12-23', 'added', 'BVI.PA'],
  ['2025-09-19', 'removed', 'TEP.PA'],
  ['2025-09-22', 'added', 'ENX.PA'],
  ['2025-12-19', 'removed', 'EDEN.PA'],
  ['2025-12-22', 'added', 'FGR.PA'],
];

// Wikipedia composition dated September 2024, then the later Euronext notices above.
const CAC_CURRENT = [
  'AC.PA', 'AI.PA', 'AIR.PA', 'MT.AS', 'CS.PA', 'BNP.PA', 'EN.PA', 'BVI.PA', 'CAP.PA', 'CA.PA',
  'ACA.PA', 'BN.PA', 'DSY.PA', 'ENGI.PA', 'EL.PA', 'ERF.PA', 'RMS.PA', 'KER.PA', 'OR.PA', 'LR.PA',
  'MC.PA', 'ML.PA', 'ORA.PA', 'RI.PA', 'PUB.PA', 'RNO.PA', 'SAF.PA', 'SGO.PA', 'SAN.PA', 'SU.PA',
  'GLE.PA', 'STLAP.PA', 'STMPA.PA', 'HO.PA', 'TTE.PA', 'URW.PA', 'VIE.PA', 'DG.PA', 'ENX.PA', 'FGR.PA',
];

function snapshot(index, source, asOf, currentSymbols, changes, notes) {
  return {
    index,
    source,
    asOf,
    currentSymbols: [...new Set(currentSymbols)].sort(),
    historicalMembership: {
      available: true,
      changes: changes
        .map(row => ({ date: row.date, added: row.added || null, removed: row.removed || null, name: row.name || null }))
        .sort((left, right) => right.date.localeCompare(left.date)),
    },
    notes,
  };
}

function main() {
  const ftse = parseFtse();
  const ftseSnap = snapshot(
    'FTSE100',
    'FTSE Russell, FTSE 100 Historic Additions and Deletions, August 2026. Current names from the Wikipedia FTSE 100 constituent table after the 1 October 2026 changes.',
    '2026-10-01',
    FTSE_CURRENT,
    ftse.changes,
    ['Temporary demerger lines (Magnum, Valterra, Jackson) are omitted because they are added and deleted within days.'],
  );
  const cacSnap = snapshot(
    'CAC40',
    'Public CAC 40 admission and removal archive at bnains.org/archives/histocac, which cites the Euronext index notices. Current names start from the Wikipedia CAC 40 table (September 2024) and then apply the 2025 notices.',
    '2025-12-22',
    CAC_CURRENT,
    CAC_CHANGES.map(([date, side, symbol]) => ({ date, [side === 'added' ? 'added' : 'removed']: symbol })),
    [
      'Thales admission is dated 2019-06-24 from the notice text, not the 2018 date printed on that row.',
      'Alstom’s 2020 return is dated 2020-09-21 with Accor’s removal. The archive row prints 22 June.',
      'Edenred’s 2023 admission row is missing its date. It is dated 2023-06-19, the session after Vivendi’s 16 June removal.',
      'Nokia’s removal and STMicroelectronics’ return use 18 September 2017 from the notice text.',
    ],
  );
  fs.writeFileSync(path.join(DIR, 'ftse100.json'), `${JSON.stringify(ftseSnap, null, 2)}\n`);
  fs.writeFileSync(path.join(DIR, 'cac40.json'), `${JSON.stringify(cacSnap, null, 2)}\n`);
  const { membershipAt } = require('../lib/research/us-universe');
  console.log('ftse changes', ftse.changes.length, 'unmapped', ftse.unmapped.length);
  console.log('ftse 2010', membershipAt(ftseSnap, '2010-01-04').size, 'now', membershipAt(ftseSnap, '2026-10-06').size);
  console.log('cac 2010', membershipAt(cacSnap, '2010-01-04').size, 'now', membershipAt(cacSnap, '2026-10-06').size);
  if (ftse.unmapped.length) console.log(ftse.unmapped.join('\n'));
}

main();
