/** A request that failed in a way the user should see: its code and one sentence (`session.ts`). */

import type { ErrorCode, RequestError } from "../shared/protocol";

export class RequestFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: RequestError["details"],
  ) {
    super(message);
  }
}
