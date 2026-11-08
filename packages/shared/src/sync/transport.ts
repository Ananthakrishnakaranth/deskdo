import type { PullResponse, PushRequest, PushResponse, ServerMessage } from "../types";

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in or session expired");
    this.name = "UnauthorizedError";
  }
}

export interface LiveHandlers {
  /** Called once the socket is open *and* authenticated. */
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  /** `reason` is a short human-readable explanation, shown in the app's status details. */
  onClose(info: { unauthorized: boolean; reason?: string }): void;
}

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(since: number): Promise<PullResponse>;
  openLive(handlers: LiveHandlers): { close(): void };
}

export interface HttpTransportOptions {
  /** e.g. "https://deskdo.onrender.com" or "" for same-origin (PWA served by the server). */
  baseUrl: string;
  /** Desktop: returns the bearer token from the OS credential store. PWA: omit (uses httpOnly cookie). */
  getToken?: () => Promise<string | null>;
  /** Close the socket if nothing (not even a server ping) arrives for this long. */
  idleTimeoutMs?: number;
  /** Give up on a connection attempt that hasn't finished (handshake + auth) in this long. */
  connectTimeoutMs?: number;
  /**
   * Abort an HTTP request that hasn't answered in this long. Without it, one request that hangs
   * (stale socket after Wi-Fi changes or sleep, a proxy, a server waking up) blocks syncing forever.
   */
  requestTimeoutMs?: number;
}

/** WebSocket close code the server uses for auth failures. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

export function createHttpTransport(opts: HttpTransportOptions): SyncTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const idleTimeoutMs = opts.idleTimeoutMs ?? 45_000; // server pings every 25 s
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 25_000;

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = opts.getToken ? await opts.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
    try {
      const res = await fetch(base + path, {
        ...init,
        headers,
        // Same-origin cookie for the PWA; bearer-only (no ambient credentials) for the desktop app.
        credentials: opts.getToken ? "omit" : "same-origin",
        cache: "no-store",
        signal: ctl.signal,
      });
      if (res.status === 401) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Server answered HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(`No answer from the server in ${Math.round(requestTimeoutMs / 1000)} s`);
      if (e instanceof UnauthorizedError || (e instanceof Error && e.message.startsWith("Server answered"))) throw e;
      throw new Error(`Can't reach the server (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  function wsUrl(): string {
    if (base) return base.replace(/^http/, "ws") + "/ws";
    const loc = globalThis.location;
    return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`;
  }

  return {
    push: (req) => request<PushResponse>("/api/ops", { method: "POST", body: JSON.stringify(req) }),
    pull: (since) => request<PullResponse>(`/api/changes?since=${since}`, { method: "GET" }),
    openLive(handlers) {
      let closed = false;
      let opened = false;
      let ws: WebSocket | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (unauthorized: boolean, reason?: string) => {
        clearTimeout(idleTimer);
        clearTimeout(connectTimer);
        if (closed) return;
        closed = true;
        handlers.onClose({ unauthorized, reason });
      };

      const resetIdle = () => {
        clearTimeout(idleTimer);
        // Half-open sockets (e.g. Wi-Fi dropped) never fire `close` on their own; the server pings
        // every 25s, so silence means the connection is dead.
        idleTimer = setTimeout(() => ws?.close(), idleTimeoutMs);
      };

      const start = async () => {
        // Fetch the token *before* connecting, so the auth message goes out the instant the socket
        // opens. (Awaiting it inside onopen added a round trip that a throttled page could stretch
        // past the server's auth deadline.)
        const token = opts.getToken ? await opts.getToken() : null;
        if (closed) return;
        const socket = new WebSocket(wsUrl());
        ws = socket;
        // A stalled handshake (proxy, antivirus, captive portal) would otherwise sit in CONNECTING
        // for minutes without ever firing close.
        connectTimer = setTimeout(() => {
          if (opened) return;
          finish(false, `Live connection didn't open within ${Math.round(connectTimeoutMs / 1000)} s`);
          socket.close();
        }, connectTimeoutMs);
        socket.onopen = () => {
          resetIdle();
          if (token) socket.send(JSON.stringify({ type: "auth", token }));
        };
        socket.onmessage = (ev) => {
          resetIdle();
          let msg: ServerMessage;
          try {
            msg = JSON.parse(String(ev.data)) as ServerMessage;
          } catch {
            return;
          }
          if (msg.type === "hello" && !opened) {
            opened = true;
            clearTimeout(connectTimer);
            handlers.onOpen();
          }
          handlers.onMessage(msg);
        };
        socket.onclose = (ev) =>
          finish(ev.code === WS_CLOSE_UNAUTHORIZED, opened ? `Live connection dropped (code ${ev.code})` : `Live connection failed (code ${ev.code})`);
        socket.onerror = () => {
          /* followed by onclose */
        };
      };
      start().catch((e: unknown) => finish(false, `Live connection failed (${e instanceof Error ? e.message : String(e)})`));

      return {
        close() {
          closed = true;
          clearTimeout(idleTimer);
          clearTimeout(connectTimer);
          ws?.close();
        },
      };
    },
  };
}
