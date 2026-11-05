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
  onClose(info: { unauthorized: boolean }): void;
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
}

/** WebSocket close code the server uses for auth failures. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

export function createHttpTransport(opts: HttpTransportOptions): SyncTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = opts.getToken ? await opts.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      ...init,
      headers,
      // Same-origin cookie for the PWA; bearer-only (no ambient credentials) for the desktop app.
      credentials: opts.getToken ? "omit" : "same-origin",
      cache: "no-store",
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return (await res.json()) as T;
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
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const ws = new WebSocket(wsUrl());

      const resetIdle = () => {
        clearTimeout(idleTimer);
        // Half-open sockets (e.g. Wi-Fi dropped) never fire `close` on their own; the server pings
        // every 25s, so silence means the connection is dead.
        idleTimer = setTimeout(() => ws.close(), idleTimeoutMs);
      };

      ws.onopen = async () => {
        resetIdle();
        const token = opts.getToken ? await opts.getToken() : null;
        if (token && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "auth", token }));
      };
      ws.onmessage = (ev) => {
        resetIdle();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "hello" && !opened) {
          opened = true;
          handlers.onOpen();
        }
        handlers.onMessage(msg);
      };
      ws.onclose = (ev) => {
        clearTimeout(idleTimer);
        if (closed) return;
        closed = true;
        handlers.onClose({ unauthorized: ev.code === WS_CLOSE_UNAUTHORIZED });
      };
      ws.onerror = () => {
        /* followed by onclose */
      };
      return {
        close() {
          closed = true;
          clearTimeout(idleTimer);
          ws.close();
        },
      };
    },
  };
}
