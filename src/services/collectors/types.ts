export interface DataCollector {
  name: string
  fetchFxRates?(currencies: string[]): Promise<Map<string, string>>
  // fetchPrices added in Module 04
}
