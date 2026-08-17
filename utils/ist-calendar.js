const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function monthParts(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) {
    const error = new Error('month must use YYYY-MM');
    error.status = 400;
    throw error;
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

function shiftMonth(month, delta) {
  const p = monthParts(month);
  const d = new Date(Date.UTC(p.year, p.month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(month) {
  monthParts(month);
  return { start: `${month}-01`, end: `${shiftMonth(month, 1)}-01` };
}

function currentIstMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function todayIst(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(month) {
  const p = monthParts(month);
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(p.year, p.month - 1, 1)));
}

module.exports = {
  currentIstMonth,
  monthBounds,
  monthLabel,
  monthParts,
  shiftMonth,
  shiftYmd,
  todayIst,
};
