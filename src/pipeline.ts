// One pass over the Ingest folder.
import { isDryRun, type Env } from "./env";
import { download, isSupported, listFolder, moveFile, type DriveFile } from "./google";
import { extractInvoice, type Extraction } from "./extract";
import { gbpPerUnit } from "./fx";
import { findBankLine } from "./match";
import { Xero } from "./xero";

type Outcome =
  | { file: string; status: "booked"; detail: string }
  | { file: string; status: "waiting"; detail: string }
  | { file: string; status: "review"; detail: string }
  | { file: string; status: "skipped"; detail: string }
  | { file: string; status: "error"; detail: string };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export async function runOnce(env: Env): Promise<Outcome[]> {
  const dry = isDryRun(env);
  const xero = new Xero(env);
  const files = (await listFolder(env, env.INGEST_FOLDER_ID)).slice(0, Number(env.MAX_FILES_PER_RUN || 5));
  if (!files.length) return [];

  const accounts = await xero.expenseAccounts();
  const usedKeys = new Set<string>(JSON.parse((await env.STATE.get("used-lines")) ?? "[]") as string[]);
  const out: Outcome[] = [];

  for (const f of files) {
    try {
      out.push(await processFile(env, xero, f, accounts, usedKeys, dry));
    } catch (e) {
      out.push({ file: f.name, status: "error", detail: String(e instanceof Error ? e.message : e) });
    }
  }
  if (!dry) await env.STATE.put("used-lines", JSON.stringify([...usedKeys].slice(-500)));
  return out;
}

async function processFile(
  env: Env,
  xero: Xero,
  f: DriveFile,
  accounts: { code: string; name: string }[],
  usedKeys: Set<string>,
  dry: boolean,
): Promise<Outcome> {
  const toReview = async (reason: string): Promise<Outcome> => {
    if (!dry) await moveFile(env, f.id, env.INGEST_FOLDER_ID, env.REVIEW_FOLDER_ID, `Needs review: ${reason}`);
    return { file: f.name, status: "review", detail: reason };
  };

  if (!isSupported(f)) return toReview(`Unsupported file type ${f.mimeType}. Use PDF, PNG or JPG.`);

  const data = await download(env, f.id);

  // Cache the extraction so files waiting for their bank line aren't re-read by Claude every run.
  const cacheKey = `extract:${f.id}`;
  let ex = JSON.parse((await env.STATE.get(cacheKey)) ?? "null") as Extraction | null;
  if (!ex) {
    ex = await extractInvoice(env, { name: f.name, mimeType: f.mimeType, data }, accounts);
    await env.STATE.put(cacheKey, JSON.stringify(ex), { expirationTtl: 60 * DAY / 1000 });
  }

  if (!ex.is_invoice) return toReview(`Doesn't look like an invoice or receipt. ${ex.notes}`);
  if (!ex.total || !/^\d{4}-\d{2}-\d{2}$/.test(ex.invoice_date)) return toReview(`Couldn't read the total or date. ${ex.notes}`);
  if (ex.total < 0) return toReview("Looks like a credit note or refund; these aren't automated yet.");
  if (ex.confidence === "low") return toReview(`Claude wasn't confident reading this. ${ex.notes}`);

  const contact = await xero.findOrCreateContact(ex.supplier_name);
  if (!contact.created && (await xero.billExists(contact.id, ex.invoice_number))) {
    return toReview(`A bill ${ex.invoice_number} from ${ex.supplier_name} is already in Xero (duplicate?).`);
  }
  const priorCode = contact.created ? null : await xero.lastAccountCodeFor(contact.id);
  const accountCode = priorCode ?? ex.account_code;

  const rate = await gbpPerUnit(ex.currency, ex.invoice_date);
  const from = iso(Date.parse(ex.invoice_date) - 5 * DAY);
  const to = iso(Math.min(Date.now(), Date.parse(ex.invoice_date) + 14 * DAY));
  const lines = await xero.statementLines(env.XERO_BANK_ACCOUNT_ID, from, to);
  const match = findBankLine(
    { supplier: ex.supplier_name, date: ex.invoice_date, total: ex.total, currency: ex.currency },
    lines,
    { gbpPerUnit: rate, fxTolerance: Number(env.FX_TOLERANCE || 0.06), daysBefore: 5, daysAfter: 14, usedKeys },
  );

  const summary = `${ex.supplier_name} ${ex.invoice_number || ""} ${ex.currency} ${ex.total.toFixed(2)} on ${ex.invoice_date}`.replace(/\s+/g, " ");
  if (!match) {
    const ageDays = (Date.now() - Date.parse(ex.invoice_date)) / DAY;
    if (ageDays < Number(env.PENDING_DAYS || 7)) {
      return { file: f.name, status: "waiting", detail: `${summary}: no matching bank line yet, will retry.` };
    }
    return toReview(`${summary}: no matching bank line found within ${env.PENDING_DAYS} days.`);
  }

  const gbp = match.line.spent;
  const foreign = ex.currency.toUpperCase() !== "GBP";
  const hasVat = !foreign && ex.uk_vat > 0;
  const reference = foreign ? `${ex.currency} ${ex.total.toFixed(2)} charged as GBP ${gbp.toFixed(2)} (rate ${(gbp / ex.total).toFixed(4)})` : "";
  const bill = {
    Type: "ACCPAY",
    Contact: { ContactID: contact.id },
    Date: ex.invoice_date,
    DueDate: match.line.date,
    InvoiceNumber: ex.invoice_number || undefined,
    Reference: reference || undefined,
    CurrencyCode: "GBP",
    Status: "AUTHORISED",
    LineAmountTypes: hasVat ? "Inclusive" : "NoTax",
    LineItems: [
      {
        Description: ex.description || summary,
        Quantity: 1,
        UnitAmount: gbp,
        AccountCode: accountCode,
        TaxType: hasVat ? env.VAT_TAX_TYPE : env.NO_VAT_TAX_TYPE,
      },
    ],
  };
  const detail =
    `${summary} → bill £${gbp.toFixed(2)} to ${accountCode}${priorCode ? " (same as last bill)" : ""}, ` +
    `paid from bank line ${match.line.date} "${match.line.description}"${match.nameMatched ? "" : " (matched on amount only)"}` +
    (ex.notes ? `. Note: ${ex.notes}` : "");

  if (dry) return { file: f.name, status: "booked", detail: `[dry run] ${detail}` };

  const invoiceId = await xero.createBill(bill);
  await xero.attach(invoiceId, f.name, data, f.mimeType);
  await xero.pay(invoiceId, env.XERO_BANK_ACCOUNT_ID, match.line.date, gbp, match.line.description.slice(0, 255));
  usedKeys.add(match.key);
  await env.STATE.delete(`extract:${f.id}`);
  await moveFile(env, f.id, env.INGEST_FOLDER_ID, env.DONE_FOLDER_ID, `Booked to Xero: ${detail}`);
  return { file: f.name, status: "booked", detail };
}
