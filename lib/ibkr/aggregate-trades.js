'use strict';

/**
 * Build the fill-derived trade rows used by the IBKR trades endpoint.
 *
 * This deliberately performs no I/O and does not mutate its input rows. The
 * surrounding caller supplies request/runtime-specific policy through context.
 */
function aggregateTrades(rows, context) {
  const {
    fifoFillsForRestoredKey,
    futuresMultiplierFor,
    ibkrAvgToFillUnit,
    fifoLotEconomics,
    ibkrFillSession,
    ibkrSessionLabel,
    isIbkrSyntheticFillRow,
    ibkrRecDayIsoFromKey,
    isCursorErrIbkrKey,
    isIbkrErrorTrade,
    fillsKeepOriginalRestoreAvg,
    isForceIbkrErrorTicker,
    legacyErrorKeys,
    errExtra
  } = context;
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }

  const trades = [];
  const needMarks = [];
  for (const [key, fillsRaw] of byKey) {
    const fills = fifoFillsForRestoredKey(fillsRaw).slice().sort((a, b) =>
      String(a && a.time || '').localeCompare(String(b && b.time || '')));
    const f0 = fills[0];
    if (!f0) continue;
    const dir = f0.side === 'sell' ? -1 : 1;
    const entries = fills.filter(f => f.role === 'entry');
    const exits = fills.filter(f => f.role !== 'entry');
    const entryQty = entries.reduce((s, f) => s + f.qty, 0);
    const exitQty = exits.reduce((s, f) => s + f.qty, 0);
    if (!entryQty) continue;
    const scale = f0.ccyScale || 1;
    const ticker = f0.ticker;
    const futMult = futuresMultiplierFor(ticker, f0.multiplier);
    const unitPx = (px) => ibkrAvgToFillUnit(px, scale, px, { ticker, multiplier: f0.multiplier }) || Number(px) || 0;
    const fifo = fifoLotEconomics(fills, { dir, unitPx, scale, futMult });
    const avgEntry = Number(fifo.avgEntry) || 0;
    const avgExit = exitQty > 0
      ? unitPx(exits.reduce((s, f) => s + f.price * f.qty, 0) / exitQty)
      : null;
    const lastExit = exitQty > 0 ? exits[exits.length - 1] : null;
    const realizedLocal = Number(fifo.realizedLocal) || 0;
    const openQty = Math.max(0, fifo.openQty);
    const rollSettleFill = fills.find(f => f && String(f.recon || '') === 'futures-roll' && f.role !== 'entry');
    const rollSettlePx = rollSettleFill ? unitPx(rollSettleFill.price) : null;
    const fifoByExit = (fifo.exitMatches || []).slice();
    const enrichFill = (f) => {
      const session = ibkrFillSession(f, f.ticker || f0.ticker, f.time);
      const matched = f.role === 'entry' ? null : fifoByExit.shift();
      return {
        role: f.role, qty: f.qty, price: unitPx(f.price), time: f.time,
        ticker: f.ticker || f0.ticker,
        side: f.side || f0.side,
        currency: f.currency || f0.currency || null,
        ccyScale: Number(f.ccyScale) || scale,
        priceCorrectedFrom: f.priceCorrectedFrom != null ? Number(f.priceCorrectedFrom) : null,
        execId: f.execId || null,
        errorTrade: !!f.errorTrade,
        commission: f.commission != null ? Number(f.commission) : null,
        commissionCcy: f.commissionCcy || null,
        ibRealizedPnl: f.ibRealizedPnl != null ? Number(f.ibRealizedPnl) : null,
        multiplier: f.multiplier != null ? Number(f.multiplier) : null,
        recon: f.recon ? String(f.recon) : null,
        userReentry: f.userReentry === true,
        userRestoreKept: f.userRestoreKept === true,
        realizedLocal: matched && Number.isFinite(Number(matched.realizedLocal))
          ? Number(matched.realizedLocal) : null,
        session,
        sessionLabel: f.sessionLabel || ibkrSessionLabel(session)
      };
    };
    const fillViews = fills.map(enrichFill);
    const stampedMult = fills.map(f => Number(f.multiplier)).find(n => n > 0)
      || (Number(f0.multiplier) > 0 ? Number(f0.multiplier) : null);
    const entrySessions = [...new Set(fillViews.filter(f => f.role === 'entry').map(f => f.sessionLabel))];
    const exitSessions = [...new Set(fillViews.filter(f => f.role !== 'entry').map(f => f.sessionLabel))];
    let sessionSummary = entrySessions[0] || '—';
    if (exitSessions.length) {
      const ex = exitSessions[exitSessions.length - 1];
      sessionSummary = entrySessions[0] && entrySessions[0] !== ex
        ? (entrySessions[0] + ' → ' + ex)
        : ex;
    } else if (entrySessions.length > 1) {
      sessionSummary = entrySessions.join(' · ');
    }
    const t = {
      key, ticker: f0.ticker, hz: f0.hz, side: f0.side,
      currency: f0.currency, ccyScale: scale,
      entryQty, exitQty, openQty, avgEntry,
      avgExit,
      lastExitPrice: lastExit ? unitPx(lastExit.price) : null,
      lastExitTime: lastExit ? lastExit.time : null,
      entrySession: entrySessions[0] || null,
      exitSession: exitSessions.length ? exitSessions[exitSessions.length - 1] : null,
      sessionSummary,
      realizedLocal,
      fills: fillViews,
      recDay: String(key).split('|')[2] || null,
      entryTime: (function () {
        const real = entries.find(f => !isIbkrSyntheticFillRow(f));
        if (real && real.time) return real.time;
        return ibkrRecDayIsoFromKey(key) || (entries[0] && entries[0].time) || f0.time;
      })(),
      lastTime: fills[fills.length - 1].time,
      rollSettlePx,
      status: openQty > 0
        ? (rollSettlePx > 0 ? 'partial' : (exitQty <= 0 ? 'open' : 'partial'))
        : 'closed',
      errorTrade: !!(f0.errorTrade || fills.some(f => f.errorTrade)
        || fillsRaw.some(f => f && f.errorTrade && !f.userReentry && !f.userRestoreKept)
        || isCursorErrIbkrKey(key)),
      multiplier: stampedMult
    };
    t.errorTrade = isIbkrErrorTrade(t, errExtra);
    if ((Number(t.openQty) || 0) > 0 && fillsKeepOriginalRestoreAvg(fillsRaw)
      && !isCursorErrIbkrKey(key) && !isForceIbkrErrorTicker(t.ticker)
      && !legacyErrorKeys.has(key)) {
      t.errorTrade = false;
    }
    trades.push(t);
    if (openQty > 0 && f0.ticker) needMarks.push(f0.ticker);
  }

  return { trades, needMarks };
}

/**
 * Price already-aggregated trades and calculate their model/error totals.
 * All external state (FX, marks, tax rules, and daily-booking policy) is
 * supplied by the caller, so this remains deterministic for a given context.
 */
async function calculateTradePnl(inputTrades, context) {
  const {
    usdPerCcy,
    fillTax,
    bookedExitPnlUsd,
    fillExitPnlUsd,
    fillDailyPnlUsd,
    futuresMultiplierFor,
    liveMarks,
    futuresStillTradable,
    markMap,
    accumulateLotDaily,
    toDailyArray
  } = context;
  const trades = inputTrades.map(t => ({ ...t, fills: t.fills.map(f => ({ ...f })) }));
  const daily = new Map();
  const dailyError = new Map();
  const dailyDetails = new Map();
  let totRealUsd = 0, totRealGrossUsd = 0, totCommissionUsd = 0, totOpenCommissionUsd = 0;
  let totUnrealUsd = 0, wins = 0, losses = 0, openCount = 0, closedCount = 0;
  let totStampDutyUsd = 0, totOpenStampDutyUsd = 0;
  let errRealUsd = 0, errUnrealUsd = 0, errOpen = 0, errClosed = 0, errCommissionUsd = 0;
  let errOpenCommissionUsd = 0;
  for (const t of trades) {
    const fx = await usdPerCcy(t.currency);
    const dir = t.side === 'sell' ? -1 : 1;
    let commissionUsd = 0;
    for (const f of t.fills) {
      const c = Number(f.commission);
      if (!(c > 0) && !(c < 0)) continue;
      const ccy = String(f.commissionCcy || t.currency || 'USD');
      const cFx = await usdPerCcy(ccy);
      commissionUsd += Math.abs(c) * cFx;
    }
    t.commissionUsd = +commissionUsd.toFixed(2);
    let stampDutyLocalAmt = 0;
    let stampDutyUsd = 0;
    let stampDutyGbp = 0;
    for (const f of t.fills) {
      const tax = fillTax(f);
      if (!tax || !(tax.amount > 0)) continue;
      stampDutyLocalAmt += tax.amount;
      const cFx = await usdPerCcy(tax.currency);
      stampDutyUsd += tax.amount * cFx;
      if (tax.id === 'uk-sdrt' || tax.currency === 'GBP') stampDutyGbp += tax.amount;
    }
    t.stampDutyLocal = +stampDutyLocalAmt.toFixed(4);
    t.stampDutyGbp = +stampDutyGbp.toFixed(4);
    t.stampDutyUsd = +stampDutyUsd.toFixed(2);
    const realizedGrossUsd = +(t.realizedLocal * fx).toFixed(2);
    t.realizedUsdGross = realizedGrossUsd;
    const lotClosed = !(t.openQty > 0);
    t.commissionInRealized = lotClosed;
    t.realizedUsd = lotClosed
      ? +(realizedGrossUsd - commissionUsd - (t.stampDutyUsd || 0)).toFixed(2)
      : +realizedGrossUsd.toFixed(2);
    const booked = bookedExitPnlUsd(t, fx);
    t.tp1RealizedUsd = booked.tp1Usd;
    t.tp2RealizedUsd = booked.tp2Usd;
    t.restRealizedUsd = booked.restUsd;
    for (const f of t.fills) {
      if (!f || f.role === 'entry') continue;
      f.realizedUsd = +fillExitPnlUsd(t, f, fx).toFixed(2);
      f.dailyRealizedUsd = +fillDailyPnlUsd(t, f, fx).toFixed(2);
    }
    let mark = markMap[t.ticker] && Number(markMap[t.ticker].price) > 0 ? Number(markMap[t.ticker].price) : null;
    if (mark != null && t.ccyScale === 100 && t.avgEntry > 0 && mark * 10 < t.avgEntry) mark *= 100;
    t.mark = mark;
    t.markSrc = mark != null ? (markMap[t.ticker] && markMap[t.ticker].src) || null : null;
    const ibmMeta = liveMarks[t.ticker];
    if (ibmMeta) {
      const metaLtd = ibmMeta.lastTradeDateOrContractMonth;
      const metaExpired = !!(ibmMeta.futExpired
        || (metaLtd && !futuresStillTradable(metaLtd)));
      if (metaExpired && t.openQty > 0) {
        t.futExpired = false;
      } else {
        t.localSymbol = ibmMeta.localSymbol || null;
        t.futLabel = ibmMeta.futLabel || null;
        t.futExpired = !!ibmMeta.futExpired;
      }
    }
    t.unrealizedUsd = (t.openQty > 0 && mark != null)
      ? +(((mark - t.avgEntry) * t.openQty * dir * futuresMultiplierFor(t.ticker, t.multiplier) / (t.ccyScale || 1)) * fx).toFixed(2)
      : (t.openQty > 0 ? null : 0);
    const nQty = t.openQty > 0 ? t.openQty : t.entryQty;
    t.notionalUsd = +((Math.abs(t.avgEntry * nQty * futuresMultiplierFor(t.ticker, t.multiplier) / (t.ccyScale || 1)) * fx)).toFixed(2);

    if (t.errorTrade) {
      errRealUsd += t.realizedUsd;
      errCommissionUsd += t.commissionUsd;
      if (!lotClosed) errOpenCommissionUsd += t.commissionUsd;
      if (t.unrealizedUsd != null) errUnrealUsd += t.unrealizedUsd;
      if (t.status === 'closed') errClosed++; else errOpen++;
    } else {
      totRealUsd += t.realizedUsd;
      totRealGrossUsd += t.realizedUsdGross;
      totCommissionUsd += t.commissionUsd;
      totStampDutyUsd += Number(t.stampDutyUsd) || 0;
      if (!lotClosed) totOpenCommissionUsd += t.commissionUsd;
      if (!lotClosed) totOpenStampDutyUsd += Number(t.stampDutyUsd) || 0;
      if (t.unrealizedUsd != null) totUnrealUsd += t.unrealizedUsd;
      if (t.status === 'closed') {
        closedCount++;
        if (t.realizedUsd > 0) wins++; else if (t.realizedUsd < 0) losses++;
      } else openCount++;
    }
    accumulateLotDaily(t, daily, dailyError, dailyDetails);
  }

  const byTicker = new Map();
  for (const t of trades) {
    if (t.errorTrade) continue;
    const k = String(t.ticker || '').toUpperCase();
    if (!byTicker.has(k)) byTicker.set(k, []);
    byTicker.get(k).push(t);
  }
  for (const [, group] of byTicker) {
    const anyFlat = group.some(t => t.hasFlatten);
    if (!anyFlat) continue;
    const groupReal = +group.reduce((s, t) => s + (t.realizedUsd || 0), 0).toFixed(2);
    for (const t of group) {
      if (t.hasFlatten || t.status === 'closed') t.tickerGroupRealizedUsd = groupReal;
    }
  }

  trades.sort((a, b) => (a.entryTime < b.entryTime ? 1 : -1));
  return {
    trades,
    dailyArr: toDailyArray(daily, dailyDetails),
    dailyErrorArr: toDailyArray(dailyError),
    totals: {
      totRealUsd, totRealGrossUsd, totCommissionUsd, totOpenCommissionUsd,
      totUnrealUsd, wins, losses, openCount, closedCount, totStampDutyUsd,
      totOpenStampDutyUsd, errRealUsd, errUnrealUsd, errOpen, errClosed,
      errCommissionUsd, errOpenCommissionUsd
    }
  };
}

module.exports = { aggregateTrades, calculateTradePnl };
