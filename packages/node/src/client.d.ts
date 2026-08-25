export interface RequestOptions {
  readonly signal?: AbortSignal;
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
  | { readonly kind: "review_method_input"; readonly method: "matrix" | "kinds" }
  | { readonly kind: "use_previous_available_fallback" }
  | { readonly kind: "try_nearby_business_day" }
  | { readonly kind: "start_new_request" }
  | { readonly kind: "update_package" };

export type ErrorCode =
  | "missing_parameter"
  | "invalid_parameter"
  | "unknown_parameter"
  | "invalid_request"
  | "source_data_unavailable"
  | "source_transport_error"
  | "source_protocol_error"
  | "source_format_error"
  | "unsupported_platform"
  | "native_package_unavailable"
  | "native_package_corrupt"
  | "internal_error";

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
  readonly baseDate: string;
  readonly requestedBaseDate: string;
  readonly dateResolution: DateResolution;
  readonly kind: YtmKind;
  readonly tenors: readonly string[];
  readonly rows: readonly YtmMatrixRow[];
  readonly source: Record<string, unknown>;
}

export interface ListYtmKindsResult {
  readonly baseDate: string | null;
  readonly kinds: readonly YtmKind[];
  readonly source: Record<string, unknown>;
}

/** @deprecated Use ListYtmKindsResult. */
export type ListYtmSortsResult = ListYtmKindsResult;

export class YtmClient {
  matrix(
    input: MatrixInput,
    options?: RequestOptions
  ): Promise<LookupYtmMatrixResult>;
  kinds(
    input?: KindsInput,
    options?: RequestOptions
  ): Promise<ListYtmKindsResult>;
}

export class YtmError extends Error {
  readonly details: SerializedError;
  constructor(details: SerializedError | Record<string, unknown>);
}

export function validateMatrixInput(input: unknown): ValidationResult<MatrixInput>;
export function validateKindsInput(input?: unknown): ValidationResult<KindsInput>;
export function serializeYtmError(error: unknown): SerializedError;
