import { describe, expect, it } from "vitest";
import { findBankLine, lineKey, toIsoDate, type BankLine } from "../src/match";
import { parseBankStatement } from "../src/xero";

const line = (p: Partial<BankLine>): BankLine => ({
  date: "2026-11-03",
  description: "",
  reference: "",
  spent: 0,
  reconciled: false,
  ...p,
});
const opts = (o: Partial<Parameters<typeof findBankLine>[2]> = {}) => ({
  gbpPerUnit: 0.78,
  fxTolerance: 0.06,
  daysBefore: 5,
  daysAfter: 14,
  usedKeys: new Set<string>(),
  ...o,
});

describe("findBankLine", () => {
  const figma = { supplier: "Figma", date: "2026-11-01", total: 20, currency: "USD" };

  it("matches a USD invoice to the GBP card charge despite FX + fees", () => {
    const lines = [
      line({ description: "TESCO STORES", spent: 15.99 }),
      line({ description: "FIGMA MONTHLY RENEWAL", spent: 16.11 }), // 20 * 0.78 = 15.60, +3.3%
    ];
    const m = findBankLine(figma, lines, opts());
    expect(m?.line.spent).toBe(16.11);
    expect(m?.nameMatched).toBe(true);
  });

  it("matches merchant names squashed together on the statement", () => {
    const m = findBankLine({ ...figma, supplier: "Google Workspace" }, [line({ description: "GOOGLE*WORKSPACE PROJ", spent: 15.7 })], opts());
    expect(m).not.toBeNull();
  });

  it("refuses a foreign match with no supplier name on the bank line", () => {
    expect(findBankLine(figma, [line({ description: "CARD PAYMENT", spent: 15.6 })], opts())).toBeNull();
  });

  it("refuses amounts outside the FX tolerance", () => {
    expect(findBankLine(figma, [line({ description: "FIGMA", spent: 19 })], opts())).toBeNull();
  });

  it("skips reconciled, already-used and out-of-window lines", () => {
    const used = line({ description: "FIGMA", spent: 15.6, date: "2026-11-02" });
    const lines = [
      line({ description: "FIGMA", spent: 15.6, reconciled: true }),
      used,
      line({ description: "FIGMA", spent: 15.6, date: "2026-12-30" }),
    ];
    expect(findBankLine(figma, lines, opts({ usedKeys: new Set([lineKey(used)]) }))).toBeNull();
  });

  it("GBP invoices need an exact amount", () => {
    const inv = { supplier: "Acme Ltd", date: "2026-11-01", total: 120, currency: "GBP" };
    expect(findBankLine(inv, [line({ description: "ACME", spent: 120.5 })], opts())).toBeNull();
    expect(findBankLine(inv, [line({ description: "DD 12345", spent: 120 })], opts())?.nameMatched).toBe(false);
  });

  it("GBP with no name and several exact candidates is ambiguous", () => {
    const inv = { supplier: "Acme Ltd", date: "2026-11-01", total: 120, currency: "GBP" };
    const lines = [line({ description: "X", spent: 120 }), line({ description: "Y", spent: 120, date: "2026-11-04" })];
    expect(findBankLine(inv, lines, opts())).toBeNull();
  });

  it("prefers the closest amount when the supplier appears twice", () => {
    const lines = [line({ description: "FIGMA", spent: 16.5 }), line({ description: "FIGMA", spent: 15.7 })];
    expect(findBankLine(figma, lines, opts())?.line.spent).toBe(15.7);
  });
});

describe("toIsoDate", () => {
  it("handles the formats Xero returns", () => {
    expect(toIsoDate("2026-11-03T00:00:00")).toBe("2026-11-03");
    expect(toIsoDate("3 Nov 2026")).toBe("2026-11-03");
    expect(toIsoDate("/Date(1762128000000+0000)/")).toBe("2025-11-03");
  });
});

describe("parseBankStatement", () => {
  it("reads spent/received columns and reconciled flag", () => {
    const rows = [
      { RowType: "Header", Cells: [{ Value: "Date" }, { Value: "Description" }, { Value: "Reference" }, { Value: "Reconciled" }, { Value: "Spent" }, { Value: "Received" }, { Value: "Balance" }] },
      {
        RowType: "Section",
        Rows: [
          { RowType: "Row", Cells: [{ Value: "2026-11-03T00:00:00" }, { Value: "FIGMA" }, { Value: "" }, { Value: "No" }, { Value: "16.11" }, { Value: "" }, { Value: "100" }] },
          { RowType: "Row", Cells: [{ Value: "2026-11-04T00:00:00" }, { Value: "CLIENT" }, { Value: "INV-1" }, { Value: "Yes" }, { Value: "" }, { Value: "500.00" }, { Value: "600" }] },
        ],
      },
    ];
    expect(parseBankStatement(rows)).toEqual([
      { date: "2026-11-03", description: "FIGMA", reference: "", spent: 16.11, reconciled: false },
      { date: "2026-11-04", description: "CLIENT", reference: "INV-1", spent: -500, reconciled: true },
    ]);
  });
});
