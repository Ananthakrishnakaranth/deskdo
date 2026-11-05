import { Entry } from "@napi-rs/keyring";

// Stored in Windows Credential Manager ("Windows Credentials" → "DeskDo"). On macOS/Linux the same
// library uses Keychain / Secret Service. The token is never written to disk by the app itself.
const SERVICE = "DeskDo";
const ACCOUNT = "session-token";

function entry(): Entry {
  return new Entry(SERVICE, ACCOUNT);
}

let cached: string | null | undefined;

export function getToken(): string | null {
  if (cached !== undefined) return cached;
  try {
    cached = entry().getPassword() ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setToken(token: string): void {
  entry().setPassword(token);
  cached = token;
}

export function clearToken(): void {
  try {
    entry().deletePassword();
  } catch {
    /* not present */
  }
  cached = null;
}
