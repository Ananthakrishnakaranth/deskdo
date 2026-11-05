import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "./modifiers";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SyncEngine, SyncStatus } from "../sync/engine";
import { countActive } from "../sync/state";
import { MAX_ACTIVE_ITEMS, MAX_TEXT_LENGTH, type TodoItem } from "../types";
import { useEngineState } from "./useEngine";

export interface TodoCardProps {
  engine: SyncEngine;
  /** "widget": compact, hover-to-reveal delete. "mobile": large tap targets, delete always visible. */
  variant: "widget" | "mobile";
  title?: string;
  /** Extra controls rendered at the right of the header (settings button, etc). */
  headerExtra?: ReactNode;
  /** Props spread on the header (desktop uses it as the window drag region). */
  headerClassName?: string;
}

export function TodoCard({ engine, variant, title = "To-do", headerExtra, headerClassName }: TodoCardProps) {
  const state = useEngineState(engine);
  const items = state.items;
  const active = countActive(items);
  const hasDone = items.some((i) => i.done);
  const full = active >= MAX_ACTIVE_ITEMS;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Long-press to drag on phones so normal scrolling/tapping still works.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    if (from >= 0 && to >= 0) engine.move(from, to);
  };

  return (
    <section className={`dd-card dd-${variant}`} aria-label={title}>
      <header className={`dd-header ${headerClassName ?? ""}`}>
        <h1 className="dd-title">{title}</h1>
        <span className="dd-count" title="Open tasks">
          {active}/{MAX_ACTIVE_ITEMS}
        </span>
        <StatusDot status={state.status} pending={state.pendingCount} />
        <div className="dd-header-extra">{headerExtra}</div>
      </header>

      {state.error && (
        <div className="dd-error" role="alert">
          <span>{state.error}</span>
          <button type="button" className="dd-icon-btn" aria-label="Dismiss" onClick={() => engine.dismissError()}>
            ×
          </button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVerticalAxis]}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="dd-list" role="list">
            {items.length === 0 && <li className="dd-empty">Nothing to do. Add a task below.</li>}
            {items.map((item) => (
              <Row key={item.id} item={item} engine={engine} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <footer className="dd-footer">
        <AddInput engine={engine} disabled={full} />
        {hasDone && (
          <button type="button" className="dd-link-btn" onClick={() => engine.clearCompleted()}>
            Clear completed
          </button>
        )}
      </footer>
    </section>
  );
}

function Row({ item, engine }: { item: TodoItem; engine: SyncEngine }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const [editing, setEditing] = useState(false);

  return (
    <li
      ref={setNodeRef}
      className={`dd-row${item.done ? " dd-done" : ""}${isDragging ? " dd-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button type="button" className="dd-handle" aria-label={`Reorder "${item.text}"`} {...attributes} {...listeners}>
        <svg viewBox="0 0 10 16" aria-hidden="true">
          {[3, 8, 13].flatMap((y) => [<circle key={`a${y}`} cx="3" cy={y} r="1.3" />, <circle key={`b${y}`} cx="7" cy={y} r="1.3" />])}
        </svg>
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.done ? `Mark "${item.text}" as not done` : `Mark "${item.text}" as done`}
        className="dd-check"
        onClick={() => engine.setDone(item.id, !item.done)}
      >
        {item.done && (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {editing ? (
        <EditInput
          initial={item.text}
          onDone={(value) => {
            setEditing(false);
            if (value !== null) engine.edit(item.id, value);
          }}
        />
      ) : (
        <span
          className="dd-text"
          role="button"
          tabIndex={0}
          title="Click to edit"
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "F2") {
              e.preventDefault();
              setEditing(true);
            }
          }}
        >
          {item.text}
        </span>
      )}
      <button type="button" className="dd-delete" aria-label={`Delete "${item.text}"`} onClick={() => engine.remove(item.id)}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

/** Inline editor: Enter saves, Esc cancels, clicking elsewhere saves. Empty text keeps the old value. */
function EditInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value !== null && value.trim() ? value : null);
  };
  return (
    <input
      ref={ref}
      className="dd-edit"
      defaultValue={initial}
      maxLength={MAX_TEXT_LENGTH}
      aria-label="Edit task"
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
        e.stopPropagation(); // keep dnd-kit's keyboard sensor out of the text field
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function AddInput({ engine, disabled }: { engine: SyncEngine; disabled: boolean }) {
  const [text, setText] = useState("");
  const submit = () => {
    // When the list is full, engine.add() refuses and shows the "list is full" banner; the typed
    // text is kept so nothing is lost once a slot frees up.
    if (disabled) return void engine.showLimitMessage();
    if (!text.trim()) return;
    if (engine.add(text).ok) setText("");
  };
  return (
    <form
      className="dd-add"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        className={`dd-add-input${disabled ? " dd-full" : ""}`}
        value={text}
        maxLength={MAX_TEXT_LENGTH}
        placeholder={disabled ? `List full (${MAX_ACTIVE_ITEMS} open tasks)` : "Add task"}
        aria-label="Add task"
        aria-describedby={disabled ? "dd-full-hint" : undefined}
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="dd-add-btn" aria-label="Add" disabled={!text.trim()}>
        +
      </button>
      {disabled && (
        <span id="dd-full-hint" className="dd-sr-only">
          The list is full. Complete or delete a task to add another.
        </span>
      )}
    </form>
  );
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  local: "Not signed in: saved on this device only",
  connecting: "Connecting…",
  online: "Synced",
  offline: "Offline: changes will sync when you reconnect",
  unauthorized: "Signed out: sign in again to sync",
};

function StatusDot({ status, pending }: { status: SyncStatus; pending: number }) {
  const label = STATUS_LABEL[status] + (pending > 0 && status !== "online" ? ` (${pending} pending)` : "");
  return <span className={`dd-status dd-status-${status}`} title={label} aria-label={label} role="status" />;
}
