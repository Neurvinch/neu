import type { RiskTier } from './types.js';

/** Amounts are decimal strings end to end. Paise resolution, integer math. */
export function toPaise(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(decimal.trim());
  if (!m) throw new Error(`invalid amount: ${decimal}`);
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

export function formatINR(decimal: string): string {
  const [int, frac = '00'] = decimal.split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `₹${grouped}.${frac.padEnd(2, '0')}`;
}

export const POLICY = {
  /** Above this, a second approver is required. */
  MEDIUM_THRESHOLD: '500000.00',
  /** Above this, the payment is "large" for risk purposes. */
  LARGE_THRESHOLD: '2000000.00',
  /** Lane B ceiling. Reserved -- Lane B is not implemented yet. */
  LANE_B_CAP: '500000.00',
  BUSINESS_HOURS: { startHour: 9, endHour: 19 },
  /** Max age of a signed intent the server will accept, independent of `exp`. */
  MAX_INTENT_AGE_MS: 90 * 60 * 1000,
} as const;

export const TIER_CONFIG: Record<RiskTier, { approvals: number; windowMinutes: number }> = {
  LOW: { approvals: 1, windowMinutes: 15 },
  MEDIUM: { approvals: 2, windowMinutes: 60 },
  HIGH: { approvals: 2, windowMinutes: 90 },
  CRITICAL: { approvals: 3, windowMinutes: 90 },
};
