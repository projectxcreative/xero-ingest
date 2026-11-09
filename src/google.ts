// Minimal Google Drive client using a service account (no SDK, Workers-friendly).
import type { Env } from "./env";

const DRIVE = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
}

const SUPPORTED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);
export const isSupported = (f: DriveFile) => SUPPORTED.has(f.mimeType);

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let cached: { token: string; exp: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google auth failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function drive(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env);
  const res = await fetch(`${DRIVE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

export async function listFolder(env: Env, folderId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent("files(id,name,mimeType,createdTime)");
  const res = await drive(
    env,
    `/files?q=${q}&fields=${fields}&orderBy=createdTime&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  );
  return ((await res.json()) as { files: DriveFile[] }).files;
}

export async function download(env: Env, fileId: string): Promise<ArrayBuffer> {
  const res = await drive(env, `/files/${fileId}?alt=media&supportsAllDrives=true`);
  return res.arrayBuffer();
}

/** Move a file between folders and record a note in its Drive description. */
export async function moveFile(env: Env, fileId: string, from: string, to: string, note: string) {
  await drive(env, `/files/${fileId}?addParents=${to}&removeParents=${from}&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: note.slice(0, 4000) }),
  });
}
