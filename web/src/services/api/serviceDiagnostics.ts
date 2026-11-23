import { recordDiagnostic, safeRequestId, type DiagnosticArea } from '../technicalDiagnostics.js'
import { ApiError } from './ApiError.js'

const reported = new WeakSet<ApiError>()

export type ApiTimeout = { stage: 'request' | 'response'; elapsed_ms: number }

export const managedRequestId = (response: Response): string | undefined =>
  typeof location !== 'undefined' && response.url.startsWith(`${location.origin}/`) ? safeRequestId(response) : undefined

export const reportHttpFailure = (area: DiagnosticArea, status: number, requestId?: string, stage: 'response' | 'download' = 'response') => {
  if (status === 408 || status === 504) {
    recordDiagnostic(area, 'timeout', { stage, http_status: status, request_id: requestId })
  } else if (status >= 500) {
    recordDiagnostic(area, 'http_error', { stage, http_status: status, request_id: requestId })
  }
}

/** A transport failure may be caught again by the task that owns the response. */
export const reportApiFailure = (area: DiagnosticArea, error: unknown, requestId?: string, timeout?: ApiTimeout) => {
  if (!(error instanceof ApiError) || error.code === 'personal_feature' || reported.has(error)) {
    return
  }
  reported.add(error)
  if (timeout) {
    recordDiagnostic(area, 'timeout', { ...timeout, request_id: requestId })
  } else if (error.status !== undefined && error.status >= 400) {
    reportHttpFailure(area, error.status, requestId)
  } else if (error.kind === 'network') {
    recordDiagnostic(area, 'network_error', { stage: 'request' })
  } else if (error.kind === 'interrupted') {
    recordDiagnostic(area, 'network_error', { stage: 'response', request_id: requestId })
  } else if (error.kind === 'protocol') {
    recordDiagnostic(area, 'invalid_response', { stage: 'response', request_id: requestId })
  }
}
