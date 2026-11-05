import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config";

export const COOKIE_NAME = "deskdo_session";

export interface Session {
  deviceId: string;
}

export class Auth {
  private readonly key: Uint8Array;
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly cfg: Config) {
    this.key = new TextEncoder().encode(cfg.jwtSecret);
  }

  /** Simple per-IP brute-force protection: 10 failed logins per 15 minutes. */
  isLockedOut(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (Date.now() > f.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= 10;
  }

  async checkPassword(ip: string, email: string, password: string): Promise<boolean> {
    // Always run bcrypt so response time doesn't reveal whether the email matched.
    const passOk = await bcrypt.compare(password, this.cfg.accountPasswordHash);
    const a = Buffer.from(email.trim().toLowerCase());
    const b = Buffer.from(this.cfg.accountEmail);
    const emailOk = a.length === b.length && timingSafeEqual(a, b);
    if (passOk && emailOk) {
      this.failures.delete(ip);
      return true;
    }
    const f = this.failures.get(ip) ?? { count: 0, resetAt: Date.now() + 15 * 60_000 };
    f.count++;
    this.failures.set(ip, f);
    return false;
  }

  async issue(deviceId: string): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.cfg.tokenTtlDays * 86_400_000);
    const token = await new SignJWT({ did: deviceId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verify(token: string | null | undefined): Promise<Session | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], subject: "owner" });
      return typeof payload.did === "string" ? { deviceId: payload.did } : null;
    } catch {
      return null;
    }
  }

  /** Bearer header (desktop) or httpOnly cookie (PWA). */
  tokenFrom(req: IncomingMessage): { token: string | null; via: "bearer" | "cookie" | null } {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return { token: h.slice(7).trim(), via: "bearer" };
    const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return c ? { token: c, via: "cookie" } : { token: null, via: null };
  }

  sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
    const parts = [
      `${COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
    ];
    if (secure) parts.push("Secure");
    return parts.join("; ");
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
