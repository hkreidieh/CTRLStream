/**
 * Structured errors. Every tool returns `{ ok: false, error: { code, message, hint, suggestedTool? } }`
 * on failure (DESIGN section 4). Handlers throw ToolError; the server wrapper turns it into that shape.
 */

export type ErrorCode =
  | 'OBS_NOT_RUNNING'
  | 'OBS_RUNNING'
  | 'OBS_NOT_CONNECTED'
  | 'WEBSOCKET_DISABLED'
  | 'WEBSOCKET_AUTH_FAILED'
  | 'WEBSOCKET_UNREACHABLE'
  | 'SAFE_MODE'
  | 'OBS_REQUEST_FAILED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_ACTIVE'
  | 'OUTPUT_NOT_ACTIVE'
  | 'CONFIG_NOT_FOUND'
  | 'FILE_ERROR'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'NOTHING_TO_UNDO'
  | 'NETWORK_ERROR'
  | 'LAUNCH_FAILED'
  | 'QUIT_FAILED'
  | 'INTERNAL';

export interface ErrorShape {
  code: ErrorCode;
  message: string;
  hint: string;
  suggestedTool?: string;
  obsStatusCode?: number;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly suggestedTool?: string;
  readonly obsStatusCode?: number;

  constructor(code: ErrorCode, message: string, hint: string, suggestedTool?: string, obsStatusCode?: number) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
    if (suggestedTool !== undefined) this.suggestedTool = suggestedTool;
    if (obsStatusCode !== undefined) this.obsStatusCode = obsStatusCode;
  }

  toShape(): ErrorShape {
    const shape: ErrorShape = { code: this.code, message: this.message, hint: this.hint };
    if (this.suggestedTool) shape.suggestedTool = this.suggestedTool;
    if (this.obsStatusCode !== undefined) shape.obsStatusCode = this.obsStatusCode;
    return shape;
  }
}

export function toErrorShape(err: unknown): ErrorShape {
  if (err instanceof ToolError) return err.toShape();
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'INTERNAL',
    message,
    hint: 'Unexpected failure inside ctrlstream. Call obs_status to check the state of OBS, then retry once.',
    suggestedTool: 'obs_status',
  };
}

/** The error every websocket tool raises when there is no live connection. */
export function notConnected(detail?: string): ToolError {
  return new ToolError(
    'OBS_NOT_CONNECTED',
    detail ? `Not connected to OBS: ${detail}` : 'Not connected to OBS.',
    'Call obs_status. If OBS is not running, call obs_launch; if it is running, call obs_connect.',
    'obs_connect',
  );
}
