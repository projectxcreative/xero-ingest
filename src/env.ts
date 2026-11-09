export interface Env {
  STATE: KVNamespace;

  DRY_RUN: string;
  CLAUDE_MODEL: string;
  PENDING_DAYS: string;
  FX_TOLERANCE: string;
  MAX_FILES_PER_RUN: string;
  VAT_TAX_TYPE: string;
  NO_VAT_TAX_TYPE: string;
  INGEST_FOLDER_ID: string;
  DONE_FOLDER_ID: string;
  REVIEW_FOLDER_ID: string;
  XERO_BANK_ACCOUNT_ID: string;
  XERO_REDIRECT_URI: string;

  ANTHROPIC_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  ADMIN_TOKEN: string;
}

export const isDryRun = (env: Env) => env.DRY_RUN !== "false";
