import { YtmClient, validateTreasuryCurveInput, type TreasuryCurveInput, type TreasuryCurveResult } from '../../packages/node/dist/client.js';

const client = new YtmClient();
const list: TreasuryCurveInput = { baseDates: ['2025-09-30'] };
const range: TreasuryCurveInput = { startDate: '2025-09-01', endDate: '2025-09-30', fallback: 'previous-available', lookbackDays: 3 };
// @ts-expect-error Date selection forms are mutually exclusive.
const mixed: TreasuryCurveInput = { ...range, baseDates: ['2025-09-30'] };
// @ts-expect-error Treasury has no KIS-NET kind.
const withKind: TreasuryCurveInput = { baseDates: ['2025-09-30'], kind: '10' };
void mixed;
void withKind;
const validation = validateTreasuryCurveInput(list);
if (validation.ok) {
  const pending: Promise<TreasuryCurveResult> = client.treasuryCurve(validation.input, { operationTimeoutMs: 120_000 });
  void pending;
}
function threeMonth(result: TreasuryCurveResult): (number | null)[] {
  return result.entries.map(entry => {
    if (entry.availability === 'unavailable') return null;
    return entry.curve.tenors.find(tenor => tenor.tenor === '3M')?.yield ?? null;
  });
}
void threeMonth;
