import { YtmClient, validateHistoryInput, type HistoryInput, type HistoryResult } from '../../packages/node/dist/client.js';

const client = new YtmClient();
const dates = ['2026-06-08', '2026-06-09'] as const;
const list: HistoryInput = { baseDates: dates };
const range: HistoryInput = { startDate: dates[0], endDate: dates[1], fallback: 'previous-available', lookbackDays: 2 };
// @ts-expect-error Date selection forms are mutually exclusive.
const mixed: HistoryInput = { ...range, baseDates: dates };
// @ts-expect-error Both range endpoints are required.
const missing: HistoryInput = { startDate: dates[0] };
void mixed;
void missing;
const validation = validateHistoryInput(list);
if (validation.ok) {
  const pending: Promise<HistoryResult> = client.history(validation.input, { signal: new AbortController().signal });
  void pending;
}
function rows(result: HistoryResult): number {
  return result.entries.reduce((count, entry) => {
    if (entry.availability === 'available') return count + entry.matrix.rows.length;
    const stage: 'discovery' | 'matrix' = entry.stage;
    void stage;
    // @ts-expect-error Unavailable pairs contain no yield matrix.
    void entry.matrix;
    return count;
  }, 0);
}
void rows;

const counted: HistoryInput = { count: 180, endDate: "2026-09-08", fallback: "exact" };
void counted;
// @ts-expect-error Count never allows previous-available substitution.
const countFallback: HistoryInput = { count: 1, endDate: "20260608", fallback: "previous-available" };
// @ts-expect-error Count requires an end date.
const countMissingEnd: HistoryInput = { count: 1 };
// @ts-expect-error Count cannot be combined with a date list.
const countList: HistoryInput = { count: 1, endDate: "20260608", baseDates: dates };
void countFallback; void countMissingEnd; void countList;

const shortfallCode: import("../../packages/node/dist/client.js").ErrorCode = "insufficient_history";
void shortfallCode;
