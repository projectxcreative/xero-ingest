// Reads an invoice/receipt with Claude and returns structured data.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Env } from "./env";

export const Extraction = z.object({
  is_invoice: z.boolean().describe("False if this is not a supplier invoice or receipt (e.g. a quote, statement, or unrelated file)."),
  supplier_name: z.string().describe("Trading name of the supplier as it would appear on a card statement, e.g. 'Figma' not 'Figma, Inc.'."),
  invoice_number: z.string().describe("Invoice or receipt number. Empty string if none."),
  invoice_date: z.string().describe("Invoice date as YYYY-MM-DD."),
  currency: z.string().describe("ISO 4217 currency code of the total, e.g. USD, GBP, EUR."),
  total: z.number().describe("Total amount charged, including any tax."),
  uk_vat: z.number().describe("UK VAT included in the total, in the invoice currency. 0 if no UK VAT is shown."),
  description: z.string().describe("Short line description, e.g. 'Figma Professional - Nov 2026'."),
  account_code: z.string().describe("Best-fitting code from the provided chart of accounts."),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the amounts, date and account code combined."),
  notes: z.string().describe("Anything a bookkeeper should know, e.g. unclear total, multiple currencies, credit note. Empty if nothing."),
});
export type Extraction = z.infer<typeof Extraction>;

export async function extractInvoice(
  env: Env,
  file: { name: string; mimeType: string; data: ArrayBuffer },
  accounts: { code: string; name: string }[],
): Promise<Extraction> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const b64 = toBase64(file.data);
  const source =
    file.mimeType === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } } as const)
      : ({
          type: "image",
          source: { type: "base64", media_type: file.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: b64 },
        } as const);

  const chart = accounts.map((a) => `${a.code}: ${a.name}`).join("\n");
  const res = await client.messages.parse({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(Extraction) },
    system:
      "You are a UK bookkeeper reading supplier invoices and receipts for a small digital marketing consultancy. " +
      "Extract the fields exactly as printed. Use the amount actually charged as the total. " +
      "Pick the account code from this chart of expense accounts (software subscriptions usually belong in a software/subscriptions or IT account):\n" +
      chart,
    messages: [{ role: "user", content: [source, { type: "text", text: `File name: ${file.name}` }] }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    throw new Error(`Claude could not read ${file.name} (stop_reason: ${res.stop_reason})`);
  }
  return res.parsed_output;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
