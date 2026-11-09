// Market reference rate (ECB, via frankfurter.dev). Only used to narrow down which bank line is the
// right one; the amount booked in Xero is always the real GBP figure from the bank.
export async function gbpPerUnit(currency: string, date: string): Promise<number> {
  if (currency.toUpperCase() === "GBP") return 1;
  const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${currency.toUpperCase()}&symbols=GBP`);
  if (!res.ok) throw new Error(`FX lookup failed for ${currency} on ${date}: ${res.status}`);
  const j = (await res.json()) as { rates: { GBP?: number } };
  if (!j.rates.GBP) throw new Error(`No GBP rate for ${currency} on ${date}`);
  return j.rates.GBP;
}
