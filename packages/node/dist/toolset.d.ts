export interface ToolRunContext {
  readonly signal?: AbortSignal;
}

export interface OperationSpec {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly resultJsonSchema: Record<string, unknown>;
  readonly requiredInputKeys: readonly string[];
  /** Direct input objects; pass an example to validateInput without unwrapping it. */
  readonly examples: readonly Record<string, unknown>[];
  readonly limitations: readonly string[];
  readonly resultSummary: string;
}

export type OperationSummary = Pick<
  OperationSpec,
  "name" | "label" | "description" | "resultSummary"
>;

export interface ToolsetHelp {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly OperationSpec[];
  readonly availableKinds: readonly string[];
  readonly guidance: readonly string[];
  readonly sourceTerms: readonly string[];
}

export type ValidationRecoveryAction =
  | { readonly kind: "inspect_tool_help" }
  | { readonly kind: "inspect_command_help"; readonly operationName: string }
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
  readonly ok?: false;
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
  readonly recoveryAction?: ValidationRecoveryAction;
  readonly recoverable?: boolean;
  readonly retryable?: boolean;
  readonly [key: string]: unknown;
}

export interface ValidationErrorDetails extends SerializedError {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly reason: string;
  readonly recoveryHint: string;
  readonly recoveryAction: ValidationRecoveryAction;
  readonly recoverable: boolean;
  readonly retryable: boolean;
}

export type ValidationResult =
  | { readonly ok: true; readonly input: Record<string, unknown> }
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

export interface KisnetYtmToolset {
  readonly id: "ytm";
  readonly label: string;
  readonly description: string;
  help(): ToolsetHelp;
  listOperations(): readonly OperationSpec[];
  getOperation(name: string): OperationSpec | undefined;
  getCommandHelp(name: string): OperationSpec | undefined;
  validateInput(
    operationName: string,
    input: unknown
  ): ValidationResult;
  execute(
    operationName: "matrix",
    input: {
      baseDate: string;
      kind: string | number;
      fallback?: "previous-available";
      lookbackDays?: number;
    },
    context?: ToolRunContext
  ): Promise<LookupYtmMatrixResult>;
  execute(
    operationName: "kinds",
    input?: { baseDate?: string },
    context?: ToolRunContext
  ): Promise<ListYtmKindsResult>;
  execute(
    operationName: string,
    input?: Record<string, unknown>,
    context?: ToolRunContext
  ): Promise<unknown>;
  serializeError(error: unknown): SerializedError;
}

export class KisnetYtmError extends Error {
  readonly details: SerializedError;
  constructor(details: SerializedError | Record<string, unknown>);
}

export function createKisnetYtmToolset(): KisnetYtmToolset;
export function validateInput(
  operationName: string,
  input: unknown
): ValidationResult;
