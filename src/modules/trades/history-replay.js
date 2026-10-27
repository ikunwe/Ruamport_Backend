const { decimal, add, subtract } = require('./valuation-decimal');
const { applySplit } = require('./history-corporate-actions');
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function replayHistoricalUnits(group, dates, actions) {
  const replay = [...group.orders, ...actions.map(event => ({ tradeDate: event.date, split: event }))]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || Number(Boolean(b.split)) - Number(Boolean(a.split)));
  let index = 0;
  let quantity = decimal(0);
  let bought = false;
  let sold = false;
  const issues = new Set();
  return dates.map(date => {
    while (index < replay.length && replay[index].tradeDate <= date) {
      const order = replay[index++];
      if (order.split) {
        // Do not revive a position already closed by the stock dust rule
        // by multiplying its retained raw residual at the split date.
        if (bought && sold && !issues.size
          && subtract({ ...quantity, n: quantity.n < 0n ? -quantity.n : quantity.n }, decimal(0.0000003)).n <= 0n)
          quantity = decimal(0);
        const adjusted = applySplit(quantity, order.split);
        if (quantity.n !== 0n && adjusted.n === 0n) issues.add('HISTORY_SPLIT_PRECISION_LOSS');
        quantity = adjusted;
        continue;
      }
      const buy = (order.assetType === 'MUTUAL_FUND' ? ['SUBSCRIPTION', 'SWITCH_IN'] : ['BUY']).includes(order.transactionType);
      const sell = (order.assetType === 'MUTUAL_FUND' ? ['REDEMPTION', 'SWITCH_OUT'] : ['SELL']).includes(order.transactionType);
      if (order.collision) issues.add('ORDER_ID_COLLISION');
      if (!buy && !sell) { issues.add('HISTORY_SPECIAL_TRANSACTION_UNSUPPORTED'); continue; }
      if (!positive(order.units)) { issues.add('HISTORY_INVALID_UNITS'); continue; }
      bought ||= buy; sold ||= sell;
      quantity = add(quantity, decimal(sell ? -order.units : order.units));
    }
    let units = quantity;
    const smallStockResidual = group.item.assetType !== 'MUTUAL_FUND' && bought && sold && !issues.size
      && subtract({ ...quantity, n: quantity.n < 0n ? -quantity.n : quantity.n }, decimal(0.0000003)).n <= 0n;
    if (smallStockResidual) units = decimal(0);
    if (units.n < 0n) issues.add('HISTORY_NEGATIVE_QUANTITY');
    return { quantity: units, active: units.n !== 0n || issues.size > 0, issues: [...issues] };
  });
}
module.exports = { replayHistoricalUnits };

