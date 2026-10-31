/** Error with an HTTP status. Serialised as { success:false, message } (same contract as the Java backend). */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
