export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Positive safe integer milliseconds; defaults to 1,800,000 for the whole retrieval. */
  readonly operationTimeoutMs?: number;
  /** Integer 0..10, defaults to 2. */
  readonly maxRetries?: number;
  /** Nonnegative safe integer milliseconds, defaults to 500. */
  readonly baseBackoffMs?: number;
  /** At least baseBackoffMs; defaults to 1000. */
  readonly maxBackoffMs?: number;
  /** Invocation-local physical attempt spacing; defaults to 0 (disabled). */
  readonly minRequestIntervalMs?: number;
  readonly progress?: RetrievalProgress;
}

export interface RetrievalStatistics {
  readonly scannedDateCount: number;
  readonly completedQualifyingDateCount: number;
  readonly discoveryCount: number;
  readonly matrixLookupCount: number;
  readonly physicalAttemptCount: number | null;
  readonly retryCount: number | null;
  readonly elapsedMs: number;
  readonly waitingMs: number;
  readonly finished: boolean;
}

/** Single-use latest snapshot; intermediate updates may coalesce. No callbacks. */
export class RetrievalProgress {
  constructor();
  snapshot(): RetrievalStatistics | null;
}

export interface MatrixInput {
  readonly baseDate: string;
  readonly kind: string | number;
  readonly fallback?: "previous-available";
  readonly lookbackDays?: number;
}

export interface KindsInput {
  readonly baseDate?: string;
}

export type RecoveryAction =
  | { readonly kind: "review_client_usage" }
  | { readonly kind: "review_method_input"; readonly method: "matrix" | "kinds" | "history" }
  | { readonly kind: "use_previous_available_fallback" }
  | { readonly kind: "try_nearby_business_day" }
  | { readonly kind: "adjust_history_selection" }
  | { readonly kind: "start_new_request" }
  | { readonly kind: "update_package" };

export type ErrorCode =
  | "missing_parameter"
  | "invalid_parameter"
  | "unknown_parameter"
  | "invalid_request"
  | "insufficient_history"
  | "source_data_unavailable"
  | "source_transport_error"
  | "source_protocol_error"
  | "source_format_error"
  | "unsupported_platform"
  | "native_package_unavailable"
  | "native_package_corrupt"
  | "internal_error";

export interface RetryDetails {
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly sourceOperation: string;
  readonly stopReason: "terminal_failure" | "attempt_exhaustion" | "operation_deadline" | "cancellation";
}

export interface SerializedError {
  readonly ok: false;
  readonly name: string;
  readonly message: string;
  readonly code?: ErrorCode | string;
  readonly reason?: string;
  readonly operationName?: string;
  readonly parameter?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly exampleInput?: Record<string, unknown>;
  readonly sourceErrorCode?: string;
  readonly sourceErrorMessage?: string;
  readonly attemptedDates?: readonly string[];
  readonly lookbackDays?: number;
  readonly cause?: string;
  readonly retry?: RetryDetails;
  readonly statistics?: RetrievalStatistics;
  readonly recoveryHint?: string;
  readonly recoveryAction?: RecoveryAction;
  readonly recoverable?: boolean;
  readonly retryable?: boolean;
  readonly [key: string]: unknown;
}

export interface ValidationErrorDetails extends SerializedError {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly reason: string;
  readonly recoveryHint: string;
  readonly recoveryAction: RecoveryAction;
  readonly recoverable: boolean;
  readonly retryable: boolean;
}

export type ValidationResult<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly error: ValidationErrorDetails };

export interface YtmKind {
  readonly code: string;
  readonly name: string;
}

export interface YtmMatrixRow {
  readonly groupName: string;
  readonly pricingGroupCode: string;
  readonly pricingGroupName: string;
  readonly yields: Record<string, number | null>;
  readonly yieldText: Record<string, string>;
  readonly raw: Record<string, string>;
}

export interface DateResolution {
  readonly mode: "exact" | "previous-available";
  readonly requestedBaseDate: string;
  readonly resolvedBaseDate: string;
  readonly usedFallback: boolean;
  readonly attemptedDates: readonly string[];
  readonly lookbackDays: number;
}

export interface LookupYtmMatrixResult {
  /** Present on top-level retrieval results; omitted from nested history matrices. */
  readonly statistics?: RetrievalStatistics;
  readonly baseDate: string;
  readonly requestedBaseDate: string;
  readonly dateResolution: DateResolution;
  readonly kind: YtmKind;
  readonly tenors: readonly string[];
  readonly rows: readonly YtmMatrixRow[];
  readonly source: Record<string, unknown>;
}

export interface ListYtmKindsResult {
  /** Present on top-level retrieval results; omitted from nested history matrices. */
  readonly statistics?: RetrievalStatistics;
  readonly baseDate: string | null;
  readonly kinds: readonly YtmKind[];
  readonly source: Record<string, unknown>;
}

export class YtmClient {
  history(input: HistoryInput, options?: RequestOptions): Promise<HistoryResult & { readonly statistics: RetrievalStatistics }>;
  matrix(
    input: MatrixInput,
    options?: RequestOptions
  ): Promise<LookupYtmMatrixResult & { readonly statistics: RetrievalStatistics }>;
  kinds(
    input?: KindsInput,
    options?: RequestOptions
  ): Promise<ListYtmKindsResult & { readonly statistics: RetrievalStatistics }>;
}

export class YtmError extends Error {
  readonly details: SerializedError;
  constructor(details: SerializedError | Record<string, unknown>);
}

export function validateMatrixInput(input: unknown): ValidationResult<MatrixInput>;
export function validateKindsInput(input?: unknown): ValidationResult<KindsInput>;
export function serializeYtmError(error: unknown): SerializedError;


/** Exactly one date selection; Rust validates, sorts and deduplicates up to 2000 dates. */
export type HistoryInput = ((
  | { readonly baseDates: readonly string[]; readonly startDate?: never; readonly endDate?: never }
  | { readonly baseDates?: never; readonly startDate: string; readonly endDate: string }
) & { readonly count?: never; readonly fallback?: "exact" | "previous-available"; readonly lookbackDays?: number })
  | { readonly count: number; readonly endDate: string; readonly startDate?: string; readonly baseDates?: never;
      readonly fallback?: "exact"; readonly lookbackDays?: never };
export type HistoryEntry =
  | { readonly availability: "available"; readonly matrix: LookupYtmMatrixResult }
  | { readonly availability: "unavailable"; readonly requestedBaseDate: string; readonly kind: YtmKind;
      readonly attemptedDates: readonly string[]; readonly mode: "exact" | "previous-available";
      readonly lookbackDays: number; readonly reason: string; readonly stage: "discovery" | "matrix" };
export interface CountSelectionMetadata {
  readonly count: number;
  readonly endDate: string;
  readonly startDate?: string;
  readonly scannedStartDate: string;
  readonly scannedDateCount: number;
}
export interface HistoryResult {
  /** Present on top-level retrieval results; omitted from nested history matrices. */
  readonly statistics?: RetrievalStatistics;
  readonly countSelection?: CountSelectionMetadata;
  readonly requestedDates: readonly string[];
  readonly discovery: readonly { readonly requestedBaseDate: string; readonly available: boolean }[];
  readonly entries: readonly HistoryEntry[];
  readonly availableCount: number;
  readonly unavailableCount: number;
  readonly dataRowCount: number;
  readonly mode: "exact" | "previous-available";
  readonly lookbackDays: number;
}
export function validateHistoryInput(input: unknown): ValidationResult<HistoryInput>;
