'use strict';

// Post-hoc diagnostic. It does not change the stored regime-sell verdicts.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'scripts', 'regime-sell-hedge-results.json');
const OUT = path.join(ROOT, 'docs', 'regime-sell-zero-trade-posthoc-2026-10-07.md');

function windowPasses(row) {
  const metrics = row.metrics || {};
  return metrics.pnlUsd > 0 && Number(metrics.winRate) >= 60;
}

function main() {
  const report = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const cells = (report.cells || []).filter(cell => cell.part === 'A');
  const onlyZero = [];
  let consistent = 0;
  let allEmpty = 0;
  for (const cell of cells) {
    if (cell.consistent) {
      consistent += 1;
      continue;
    }
    const windows = cell.windows || [];
    if (windows.length !== 4) continue;
    const empty = windows.filter(row => !(row.metrics && row.metrics.trades > 0));
    const active = windows.filter(row => row.metrics && row.metrics.trades > 0);
    if (!empty.length) continue;
    if (!active.length) {
      allEmpty += 1;
      continue;
    }
    if (active.every(windowPasses)) onlyZero.push(cell);
  }
  const lines = [
    '# Regime-sell Part A — post-hoc zero-trade diagnostic',
    '',
    'POST-HOC. This does not change the stored verdicts in `scripts/regime-sell-hedge-results.json` or `docs/regime-sell-hedge-readout.md`.',
    'A Part A window passes the frozen rule when its pnl is positive and its win rate is at least 60%. A window with zero trades fails that rule because its pnl is not positive.',
    'A variant is in the table below when every window that has trades would pass, and at least one window has zero trades. That is the only reason it is not consistent.',
    '',
    `Part A variants: ${cells.length}. Stored consistent: ${consistent}.`,
    `Failed only because a window had zero trades: ${onlyZero.length}.`,
    `Separate count, all four windows empty: ${allEmpty}. Those are not in the table, because there is no window with trades to treat as neutral.`,
    '',
    'Neutral rescore: a zero-trade window is ignored. The variant is neutral-consistent when every window that has trades passes.',
    '',
  ];
  if (!onlyZero.length) {
    lines.push('No Part A variant failed only because a window had zero trades.', '');
  } else {
    lines.push('| Variant | Neutral | Window 1 | Window 2 | Window 3 | Window 4 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const cell of onlyZero) {
      const bits = (cell.windows || []).map(row => {
        const metrics = row.metrics || {};
        if (!(metrics.trades > 0)) return 'neutral (0 trades)';
        return `pass ${metrics.pnlUsd} / ${metrics.winRate}% / ${metrics.trades} trades`;
      });
      lines.push(`| ${cell.id} | yes | ${bits.join(' | ')} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`A ${cells.length} only-zero ${onlyZero.length} all-empty ${allEmpty} consistent ${consistent}`);
  console.log(`wrote ${OUT}`);
}

main();
