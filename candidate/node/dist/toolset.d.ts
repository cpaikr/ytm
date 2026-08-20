export interface ToolRunContext {
  signal?: AbortSignal;
}

export interface OperationSpec {
  name: string;
  label: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  resultJsonSchema: Record<string, unknown>;
  requiredInputKeys: string[];
  examples: Array<{ input: Record<string, unknown> }>;
  limitations: string[];
  resultSummary: string;
}

export interface ValidationErrorDetails {
  ok: false;
  code: "missing_parameter" | "invalid_parameter" | "unknown_parameter" | "invalid_request" | "source_data_unavailable" | "source_transport_error" | "source_protocol_error" | "source_format_error" | "internal_error";
  operationName?: string;
  parameter?: string;
  reason: string;
  expected?: unknown;
  actual?: unknown;
  exampleInput?: unknown;
  sourceErrorCode?: string;
  sourceErrorMessage?: string;
  attemptedDates?: string[];
  lookbackDays?: number;
  cause?: string;
  recoveryHint: string;
  recoveryAction: "inspect_tool_help" | "inspect_command_help" | "use_previous_available_fallback" | "try_nearby_business_day" | "update_package";
  recoverable: boolean;
  retryable?: boolean;
}

export type ValidationResult =
  | { valid: true; normalizedInput: Record<string, unknown> }
  | { valid: false; error: ValidationErrorDetails };

export interface YtmKind {
  code: string;
  name: string;
}

export interface YtmMatrixRow {
  groupName: string;
  pricingGroupCode: string;
  pricingGroupName: string;
  yields: Record<string, number | null>;
  yieldText: Record<string, string>;
  raw: Record<string, string>;
}

export interface DateResolution {
  mode: "exact" | "previous-available";
  requestedBaseDate: string;
  resolvedBaseDate: string;
  usedFallback: boolean;
  attemptedDates: string[];
  lookbackDays: number;
}

export interface LookupYtmMatrixResult {
  baseDate: string;
  requestedBaseDate: string;
  dateResolution: DateResolution;
  kind: YtmKind;
  tenors: string[];
  rows: YtmMatrixRow[];
  source: Record<string, unknown>;
}

export interface ListYtmSortsResult {
  baseDate: string | null;
  kinds: YtmKind[];
  source: Record<string, unknown>;
}

export interface KisnetYtmToolset {
  id: "ytm";
  label: string;
  description: string;
  help(): string;
  listOperations(): OperationSpec[];
  getOperation(name: string): OperationSpec | undefined;
  getCommandHelp(name: string): string | undefined;
  validateInput(operationName: string, input: unknown): ValidationResult;
  execute(operationName: "matrix", input: { baseDate: string; kind: string | number; fallback?: "previous-available"; lookbackDays?: number }, context?: ToolRunContext): Promise<LookupYtmMatrixResult>;
  execute(operationName: "kinds", input?: { baseDate?: string }, context?: ToolRunContext): Promise<ListYtmSortsResult>;
  execute(operationName: string, input: unknown, context?: ToolRunContext): Promise<unknown>;
  serializeError(error: unknown): ValidationErrorDetails | Record<string, unknown>;
}

export class KisnetYtmError extends Error {
  details: ValidationErrorDetails | Record<string, unknown>;
  constructor(details: ValidationErrorDetails | Record<string, unknown>);
}

export function createKisnetYtmToolset(): KisnetYtmToolset;
export function validateInput(operationName: string, input: unknown): ValidationResult;
