export const CARRIER_CONFIG = {
  telcel: { label: 'Telcel', color: '#0033A0', rechargeDays: null, alertDays: 7 },
  att: { label: 'AT&T', color: '#009FDB', rechargeDays: 85, alertDays: 7 },
  oxxocel: { label: 'OXXO Cel', color: '#E30613', rechargeDays: 170, alertDays: 10 },
};

const CARRIER_BY_LANK_ACCOUNT_ID = {
  3: 'att',
  4: 'att',
  5: 'att',
  6: 'oxxocel',
  10: 'telcel',
};

export function resolveSimCarrier(sim) {
  const accountCarrier = CARRIER_BY_LANK_ACCOUNT_ID[Number(sim?.lankAccountId)];
  if (accountCarrier && CARRIER_CONFIG[accountCarrier]) return accountCarrier;

  const carrier = sim?.carrier;
  if (carrier && CARRIER_CONFIG[carrier]) return carrier;

  return 'telcel';
}

export function normalizeSimCarrier(sim) {
  if (!sim) return sim;
  const carrier = resolveSimCarrier(sim);
  if (sim.carrier === carrier) return sim;
  return { ...sim, carrier };
}
