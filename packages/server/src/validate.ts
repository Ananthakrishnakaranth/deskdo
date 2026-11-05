import { MAX_TEXT_LENGTH, type Op, type TodoPatch } from "@deskdo/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function text(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) throw new ValidationError(`${field} must not be empty`);
  if (t.length > MAX_TEXT_LENGTH) throw new ValidationError(`${field} is too long`);
  return t;
}
function finite(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${field} must be a finite number`);
  return v;
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return v;
}
function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new ValidationError(`${field} must be a UUID`);
  return v.toLowerCase();
}

/** Strictly parse an untrusted op. Unknown fields are dropped. */
export function parseOp(raw: unknown): Op {
  if (!isObj(raw)) throw new ValidationError("op must be an object");
  const base = {
    opId: uuid(raw.opId, "opId"),
    itemId: uuid(raw.itemId, "itemId"),
    clientTime: typeof raw.clientTime === "number" ? raw.clientTime : 0,
  };
  switch (raw.type) {
    case "create":
      return { ...base, type: "create", text: text(raw.text, "text"), done: bool(raw.done ?? false, "done"), position: finite(raw.position, "position") };
    case "update": {
      if (!isObj(raw.patch)) throw new ValidationError("patch must be an object");
      const patch: TodoPatch = {};
      if (raw.patch.text !== undefined) patch.text = text(raw.patch.text, "patch.text");
      if (raw.patch.done !== undefined) patch.done = bool(raw.patch.done, "patch.done");
      if (raw.patch.position !== undefined) patch.position = finite(raw.patch.position, "patch.position");
      if (Object.keys(patch).length === 0) throw new ValidationError("patch is empty");
      return { ...base, type: "update", patch };
    }
    case "delete":
      return { ...base, type: "delete" };
    default:
      throw new ValidationError("unknown op type");
  }
}

export function parseDeviceId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new ValidationError("deviceId is invalid");
  return v;
}
