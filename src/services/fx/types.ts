export class FXRateUnavailableError extends Error {
  constructor(currency: string) {
    super(`No FX rate available for ${currency}`)
    this.name = 'FXRateUnavailableError'
  }
}
