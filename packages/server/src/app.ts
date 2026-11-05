import type { LoginRequest, LoginResponse } from "@deskdo/shared";
import { WS_CLOSE_UNAUTHORIZED } from "@deskdo/shared";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Auth, type Session } from "./auth";
import type { Config } from "./config";
import type { Db } from "./db";
import { Hub } from "./hub";
import { applyOps, changesSince } from "./ops";
import { parseDeviceId, parseOp, ValidationError } from "./validate";

const MAX_BODY = 256 * 1024;
const MAX_OPS_PER_PUSH = 200;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface App {
  server: Server;
  hub: Hub;
  close(): Promise<void>;
}

export function createApp(cfg: Config, db: Db): App {
  const auth = new Auth(cfg);
  const hub = new Hub();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  const isSecure = (req: IncomingMessage) =>
    cfg.cookieSecure ?? (req.headers["x-forwarded-proto"] === "https" || "encrypted" in req.socket);

  function clientIp(req: IncomingMessage): string {
    // Use the entry appended by the nearest proxy (Render/Fly); the left-most one is client-controlled.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return xff.at(-1) ?? req.socket.remoteAddress ?? "unknown";
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    try {
      const host = new URL(origin).host;
      return host === req.headers.host || cfg.allowedOrigins.includes(origin);
    } catch {
      return false;
    }
  }

  async function requireSession(req: IncomingMessage): Promise<Session> {
    const { token, via } = auth.tokenFrom(req);
    // Cookie auth is ambient, so only accept it from our own origin (CSRF defence in depth on top of SameSite=Strict).
    if (via === "cookie" && !originAllowed(req)) throw new HttpError(403, "cross-origin cookie request");
    const s = await auth.verify(token);
    if (!s) throw new HttpError(401, "unauthorized");
    return s;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Bearer clients (the desktop app) call from a non-http origin, so allow any origin. This is safe
    // because "*" forbids credentialed (cookie) requests — cookies only work same-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "POST /api/login": {
        const ip = clientIp(req);
        if (auth.isLockedOut(ip)) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
        const body = (await readJson(req)) as Partial<LoginRequest>;
        const deviceId = parseDeviceId(body.deviceId);
        if (typeof body.email !== "string" || typeof body.password !== "string") throw new HttpError(400, "email and password required");
        if (!(await auth.checkPassword(ip, body.email, body.password))) throw new HttpError(401, "Wrong email or password.");
        const { token, expiresAt } = await auth.issue(deviceId);
        const out: LoginResponse = { expiresAt: expiresAt.toISOString() };
        if (body.mode === "cookie") {
          if (!originAllowed(req)) throw new HttpError(403, "cookie login must be same-origin");
          res.setHeader("Set-Cookie", auth.sessionCookie(token, expiresAt, isSecure(req)));
        } else {
          out.token = token;
        }
        return json(res, 200, out);
      }
      case "POST /api/logout":
        res.setHeader("Set-Cookie", auth.clearCookie(isSecure(req)));
        return json(res, 200, { ok: true });
      case "GET /api/session": {
        const s = await requireSession(req);
        return json(res, 200, { deviceId: s.deviceId });
      }
      case "POST /api/ops": {
        await requireSession(req);
        const body = (await readJson(req)) as { deviceId?: unknown; ops?: unknown };
        const deviceId = parseDeviceId(body.deviceId);
        if (!Array.isArray(body.ops) || body.ops.length > MAX_OPS_PER_PUSH) throw new HttpError(400, "ops must be an array (max 200)");
        const ops = body.ops.map(parseOp);
        const result = await applyOps(db, deviceId, ops);
        // Tell every connected device (including the sender's other tabs) about the new state.
        hub.broadcast(result.items, result.cursor);
        return json(res, 200, result);
      }
      case "GET /api/changes": {
        await requireSession(req);
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isInteger(since) || since < 0) throw new HttpError(400, "bad since");
        return json(res, 200, await changesSince(db, since));
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (cfg.staticDir && (req.method === "GET" || req.method === "HEAD")) return await serveStatic(cfg.staticDir, url.pathname, req, res);
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      if (e instanceof ValidationError) return json(res, 400, { error: e.message });
      console.error(e);
      return json(res, 500, { error: "internal error" });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void onSocket(ws, req));
  });

  async function onSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const reject = () => ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
    const { token, via } = auth.tokenFrom(req);
    if (via === "cookie") {
      // Cross-site WebSocket hijacking defence: cookies are ambient, so check Origin.
      if (!originAllowed(req) || !(await auth.verify(token))) return reject();
      return hub.add(ws, (await changesSince(db, Number.MAX_SAFE_INTEGER)).cursor);
    }
    // Bearer clients authenticate with their first message (browsers can't set WS headers, and
    // query-string tokens end up in proxy logs).
    const timer = setTimeout(reject, 5_000);
    ws.once("message", async (data) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(String(data)) as { type?: string; token?: string };
        if (msg.type !== "auth" || !(await auth.verify(msg.token))) return reject();
        hub.add(ws, (await changesSince(db, Number.MAX_SAFE_INTEGER)).cursor);
      } catch {
        reject();
      }
    });
  }

  return {
    server,
    hub,
    async close() {
      hub.close();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = path.resolve(root);
  let file = path.resolve(base, "." + decodeURIComponent(pathname));
  if (!file.startsWith(base + path.sep) && file !== base) throw new HttpError(404, "not found");
  let st = await stat(file).catch(() => null);
  if (!st || st.isDirectory()) {
    // SPA fallback
    file = path.join(base, "index.html");
    st = await stat(file).catch(() => null);
    if (!st) throw new HttpError(404, "not found");
  }
  const ext = path.extname(file);
  const host = req.headers.host ?? "";
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self' wss://${host} ws://${host}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  );
  // Hashed build assets are immutable; everything else (index.html, sw.js, manifest) must revalidate
  // so PWA updates roll out.
  res.setHeader("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  res.writeHead(200);
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}
