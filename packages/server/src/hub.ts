import type { ServerMessage, TodoItem } from "@deskdo/shared";
import { WebSocket } from "ws";

/** Fan-out of change notifications to every connected, authenticated client. */
export class Hub {
  private sockets = new Set<WebSocket>();
  private alive = new WeakMap<WebSocket, boolean>();
  private timer: NodeJS.Timeout;

  constructor(pingIntervalMs = 25_000) {
    // Two layers: protocol pings detect dead peers server-side; the JSON "ping" lets browser clients
    // (which can't see protocol pings) detect a dead connection from their side.
    this.timer = setInterval(() => {
      for (const ws of this.sockets) {
        if (this.alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        this.alive.set(ws, false);
        ws.ping();
        this.send(ws, { type: "ping" });
      }
    }, pingIntervalMs);
    this.timer.unref();
  }

  add(ws: WebSocket, cursor: number): void {
    this.sockets.add(ws);
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));
    ws.on("close", () => this.sockets.delete(ws));
    this.send(ws, { type: "hello", cursor });
  }

  broadcast(items: TodoItem[], cursor: number): void {
    if (items.length === 0) return;
    const msg: ServerMessage = { type: "changes", items, cursor };
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  get size(): number {
    return this.sockets.size;
  }

  close(): void {
    clearInterval(this.timer);
    for (const ws of this.sockets) ws.terminate();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
