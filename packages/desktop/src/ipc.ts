// Contract between the preload bridge and the renderer. Types only.
import type { LocalSnapshot, Op, TodoItem } from "@deskdo/shared";

export interface DesktopSettings {
  serverUrl: string;
  email: string;
  openAtLogin: boolean;
}

export interface DeskdoBridge {
  store: {
    load(): Promise<LocalSnapshot>;
    saveItems(items: TodoItem[], cursor: number): Promise<void>;
    saveOutbox(ops: Op[]): Promise<void>;
    clear(): Promise<void>;
  };
  auth: {
    /** Signs in through the main process; the token goes straight to Windows Credential Manager. */
    login(serverUrl: string, email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }>;
    logout(): Promise<void>;
    getToken(): Promise<string | null>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    setOpenAtLogin(on: boolean): Promise<void>;
  };
  win: {
    resizeTo(width: number, height: number): void;
    hide(): void;
  };
  /** Main → renderer events. Each returns an unsubscribe function. */
  on: {
    openSettings(cb: () => void): () => void;
    resume(cb: () => void): () => void;
  };
}

declare global {
  interface Window {
    deskdo: DeskdoBridge;
  }
}
