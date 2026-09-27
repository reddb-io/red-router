/** Preserve an upstream status for diagnosis without exposing its response body. */
export class QoderCnHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly statusCode: number
  ) {
    super(`Qoder CN ${operation} returned HTTP ${statusCode}`);
    this.name = "QoderCnHttpError";
  }
}
