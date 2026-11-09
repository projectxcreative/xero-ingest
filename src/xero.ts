// Minimal Xero Accounting API client (OAuth2 with a stored, rotating refresh token).
import type { Env } from "./env";
import { toIsoDate, type BankLine } from "./match";

const API = "https://api.xero.com/api.xro/2.0";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const DEFAULT_SCOPES =
  "openid profile email offline_access accounting.transactions accounting.contacts accounting.settings.read accounting.attachments accounting.reports.read";

interface Token {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export function authorizeUrl(env: Env & { XERO_SCOPES?: string }, state: string) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: env.XERO_REDIRECT_URI,
    scope: env.XERO_SCOPES || DEFAULT_SCOPES,
    state,
  });
  return `https://login.xero.com/identity/connect/authorize?${p}`;
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<Token> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const token = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 };
  await env.STATE.put("xero:token", JSON.stringify(token));
  return token;
}

/** Called from /xero/callback after you approve access in Xero. */
export async function completeConnect(env: Env, code: string) {
  const token = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: env.XERO_REDIRECT_URI });
  const res = await fetch("https://api.xero.com/connections", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const conns = (await res.json()) as { tenantId: string; tenantName: string; tenantType: string }[];
  const org = conns.find((c) => c.tenantType === "ORGANISATION");
  if (!org) throw new Error("No Xero organisation was connected");
  await env.STATE.put("xero:tenant", JSON.stringify(org));
  return org;
}

async function accessToken(env: Env): Promise<string> {
  const raw = await env.STATE.get("xero:token");
  if (!raw) throw new Error("Xero is not connected yet. Visit /xero/connect?key=ADMIN_TOKEN");
  let token = JSON.parse(raw) as Token;
  if (token.expires_at < Date.now() + 60_000) {
    token = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: token.refresh_token });
  }
  return token.access_token;
}

export class Xero {
  constructor(private env: Env) {}

  private async call<T>(method: string, path: string, body?: unknown, raw?: { data: ArrayBuffer; type: string }): Promise<T> {
    const tenant = JSON.parse((await this.env.STATE.get("xero:tenant")) ?? "null") as { tenantId: string } | null;
    if (!tenant) throw new Error("Xero tenant not set. Reconnect at /xero/connect");
    const headers: Record<string, string> = {
      authorization: `Bearer ${await accessToken(this.env)}`,
      "xero-tenant-id": tenant.tenantId,
      accept: "application/json",
    };
    let payload: BodyInit | undefined;
    if (raw) {
      headers["content-type"] = raw.type;
      payload = raw.data;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}${path}`, { method, headers, body: payload });
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? "5") * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Xero ${method} ${path} failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    }
  }

  async expenseAccounts() {
    const r = await this.call<{ Accounts: { Code: string; Name: string; Class: string; Status: string; Type: string }[] }>(
      "GET",
      `/Accounts?where=${encodeURIComponent('Status=="ACTIVE"&&Class=="EXPENSE"')}`,
    );
    return r.Accounts.filter((a) => a.Code).map((a) => ({ code: a.Code, name: a.Name }));
  }

  async bankAccounts() {
    const r = await this.call<{ Accounts: { AccountID: string; Name: string; CurrencyCode: string; BankAccountNumber?: string }[] }>(
      "GET",
      `/Accounts?where=${encodeURIComponent('Type=="BANK"')}`,
    );
    return r.Accounts.map((a) => ({ id: a.AccountID, name: a.Name, currency: a.CurrencyCode }));
  }

  async findOrCreateContact(name: string): Promise<{ id: string; created: boolean }> {
    const r = await this.call<{ Contacts: { ContactID: string; Name: string }[] }>(
      "GET",
      `/Contacts?searchTerm=${encodeURIComponent(name)}&summaryOnly=true`,
    );
    const exact = r.Contacts.find((c) => c.Name.toLowerCase() === name.toLowerCase()) ?? r.Contacts[0];
    if (exact) return { id: exact.ContactID, created: false };
    const c = await this.call<{ Contacts: { ContactID: string }[] }>("PUT", "/Contacts", { Contacts: [{ Name: name }] });
    return { id: c.Contacts[0].ContactID, created: true };
  }

  /** Account code used on the supplier's most recent bill, if any. */
  async lastAccountCodeFor(contactId: string): Promise<string | null> {
    const r = await this.call<{ Invoices: { InvoiceID: string }[] }>(
      "GET",
      `/Invoices?ContactIDs=${contactId}&where=${encodeURIComponent('Type=="ACCPAY"')}&order=Date%20DESC&page=1&pageSize=1`,
    );
    if (!r.Invoices.length) return null;
    const full = await this.call<{ Invoices: { LineItems: { AccountCode?: string }[] }[] }>("GET", `/Invoices/${r.Invoices[0].InvoiceID}`);
    return full.Invoices[0]?.LineItems.find((l) => l.AccountCode)?.AccountCode ?? null;
  }

  async billExists(contactId: string, invoiceNumber: string): Promise<boolean> {
    if (!invoiceNumber) return false;
    const where = `Type=="ACCPAY"&&InvoiceNumber=="${invoiceNumber.replace(/"/g, "")}"&&Status!="DELETED"&&Status!="VOIDED"`;
    const r = await this.call<{ Invoices: unknown[] }>(
      "GET",
      `/Invoices?ContactIDs=${contactId}&where=${encodeURIComponent(where)}&summaryOnly=true`,
    );
    return r.Invoices.length > 0;
  }

  /**
   * Bank statement lines (from the bank feed) for an account and date range, via the BankStatement report.
   * Columns are found by header name so small layout differences don't break parsing.
   */
  async statementLines(bankAccountId: string, from: string, to: string): Promise<BankLine[]> {
    const r = await this.call<{ Reports: { Rows: Row[] }[] }>(
      "GET",
      `/Reports/BankStatement?bankAccountID=${bankAccountId}&fromDate=${from}&toDate=${to}`,
    );
    return parseBankStatement(r.Reports[0]?.Rows ?? []);
  }

  async rawBankStatement(bankAccountId: string, from: string, to: string) {
    return this.call<unknown>("GET", `/Reports/BankStatement?bankAccountID=${bankAccountId}&fromDate=${from}&toDate=${to}`);
  }

  async createBill(bill: unknown): Promise<string> {
    const r = await this.call<{ Invoices: { InvoiceID: string; HasErrors?: boolean; ValidationErrors?: { Message: string }[] }[] }>(
      "PUT",
      "/Invoices",
      { Invoices: [bill] },
    );
    const inv = r.Invoices[0];
    if (inv.HasErrors) throw new Error(`Xero rejected bill: ${inv.ValidationErrors?.map((e) => e.Message).join("; ")}`);
    return inv.InvoiceID;
  }

  async attach(invoiceId: string, fileName: string, data: ArrayBuffer, mimeType: string) {
    await this.call("PUT", `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`, undefined, { data, type: mimeType });
  }

  async pay(invoiceId: string, bankAccountId: string, date: string, amount: number, reference: string) {
    await this.call("PUT", "/Payments", {
      Payments: [{ Invoice: { InvoiceID: invoiceId }, Account: { AccountID: bankAccountId }, Date: date, Amount: amount, Reference: reference }],
    });
  }
}

interface Cell {
  Value?: string;
}
interface Row {
  RowType: string;
  Cells?: Cell[];
  Rows?: Row[];
}

export function parseBankStatement(rows: Row[]): BankLine[] {
  const header = rows.find((r) => r.RowType === "Header")?.Cells?.map((c) => (c.Value ?? "").toLowerCase()) ?? [];
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col("date");
  const iDesc = col("description", "payee");
  const iRef = col("reference");
  const iRec = col("reconciled");
  const iSpent = col("spent");
  const iRecv = col("received");
  const iAmount = col("amount");

  const lines: BankLine[] = [];
  const walk = (rs: Row[]) => {
    for (const r of rs) {
      if (r.Rows) walk(r.Rows);
      if (r.RowType !== "Row" || !r.Cells) continue;
      const v = (i: number) => (i >= 0 ? (r.Cells![i]?.Value ?? "").trim() : "");
      const num = (s: string) => (s ? Number(s.replace(/[^0-9.-]/g, "")) : 0);
      let spent: number;
      if (iSpent >= 0 || iRecv >= 0) spent = num(v(iSpent)) - num(v(iRecv));
      else spent = -num(v(iAmount)); // single signed amount column: negative = money out
      const date = toIsoDate(v(iDate));
      if (!date || Number.isNaN(spent)) continue;
      lines.push({
        date,
        description: v(iDesc),
        reference: v(iRef),
        spent: Math.round(spent * 100) / 100,
        reconciled: /^(yes|true)$/i.test(v(iRec)),
      });
    }
  };
  walk(rows);
  return lines;
}
