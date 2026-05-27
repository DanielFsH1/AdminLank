export const CARRIER_CONFIG = {
  telcel: { label: 'Telcel', color: '#0033A0', rechargeDays: null, alertDays: 7 },
  att: { label: 'AT&T', color: '#009FDB', rechargeDays: 85, alertDays: 7 },
  oxxocel: { label: 'OXXO Cel', color: '#E30613', rechargeDays: 170, alertDays: 10 },
};

const LEGACY_CARRIER_BY_LANK_ACCOUNT_ID = {
  10: 'oxxocel',
};

export function resolveSimCarrier(sim) {
  const legacyCarrier = LEGACY_CARRIER_BY_LANK_ACCOUNT_ID[Number(sim?.lankAccountId)];
  if (legacyCarrier && CARRIER_CONFIG[legacyCarrier]) return legacyCarrier;

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
