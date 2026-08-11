async function drainBatches({
  batchSize,
  maxBatches,
  maxRuntimeMs,
  loadBatch,
  processBatch,
  loadRemaining,
  now = Date.now,
}) {
  const startedAt = now();
  const totals = {
    evaluated: 0,
    transitioned: 0,
    paused: 0,
    dormant: 0,
    failed: 0,
    batches: 0,
  };

  let stopReason = 'drained';
  let sourceExhausted = false;
  while (totals.batches < maxBatches) {
    if (now() - startedAt >= maxRuntimeMs) {
      stopReason = 'max_runtime';
      break;
    }
    const candidates = await loadBatch(batchSize);
    if (!candidates.length) {
      sourceExhausted = true;
      break;
    }
    const batch = await processBatch(candidates);
    totals.batches += 1;
    totals.evaluated += Number(batch.evaluated) || 0;
    totals.transitioned += Number(batch.transitioned) || 0;
    totals.paused += Number(batch.paused) || 0;
    totals.dormant += Number(batch.dormant) || 0;
    totals.failed += Number(batch.failed) || 0;
  }

  const remaining = await loadRemaining();
  if (remaining > 0 && stopReason === 'drained') {
    if (totals.batches >= maxBatches) stopReason = 'max_batches';
    else if (sourceExhausted) stopReason = 'deferred_remaining';
    else stopReason = 'max_runtime';
  }
  return {
    ...totals,
    processed: totals.evaluated,
    remaining,
    backlog: remaining > 0,
    drained: remaining === 0,
    stopReason,
    runtimeMs: Math.max(0, now() - startedAt),
  };
}

module.exports = { drainBatches };
