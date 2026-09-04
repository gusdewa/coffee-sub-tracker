import type { Response } from 'express'

/**
 * One error envelope, with machine-readable codes the frontend switches on.
 * Internal detail never crosses this boundary: the client gets the code and a
 * human sentence, the server log gets the cause.
 */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  NOT_ALLOWLISTED: 403,
  ACCOUNT_UNBOUND: 403,
  ALREADY_BOUND: 409,
  NOT_CLAIMABLE: 409,
  MEMBER_NOT_FOUND: 404,
  EMAIL_ALREADY_LINKED: 409,
  MEMBER_ALREADY_LINKED: 409,
  MEMBER_DISABLED: 403,
  WRONG_DOMAIN: 403,
  ADMIN_REQUIRED: 403,
  QA_SCOPE_DENIED: 403,
  QA_LINK_INVALID: 403,
  QA_UNAVAILABLE: 503,
  NO_BALANCE: 409,
  ALREADY_UNDONE: 409,
  UNDO_WINDOW_EXPIRED: 409,
  INSUFFICIENT_BALANCE: 409,
  NOT_REVERSIBLE: 409,
  NOT_LATEST_CONSUME: 409,
  TRANSACTION_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  STORAGE_CONFLICT: 503,
}

/** Messages safe to echo verbatim; anything else is replaced. */
const GENERIC_MESSAGE: Record<string, string> = {
  UNAUTHENTICATED: 'Sign-in required',
  STORAGE_CONFLICT: 'The service is busy, please try again',
}

export function sendError(res: Response, err: unknown): void {
  const code = (err as { code?: string }).code ?? 'INTERNAL'
  const status = STATUS_BY_CODE[code] ?? 500

  if (status >= 500) {
    console.error('[error]', code, (err as Error).message)
  }

  const message =
    GENERIC_MESSAGE[code] ??
    (status < 500 ? ((err as Error).message ?? 'Request failed') : 'Something went wrong')

  const body: ErrorBody = { error: { code, message } }
  res.status(status).json(body)
}
