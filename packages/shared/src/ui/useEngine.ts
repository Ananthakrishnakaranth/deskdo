import { useSyncExternalStore } from "react";
import type { EngineState, SyncEngine } from "../sync/engine";

/** Subscribe a component to the sync engine's state. */
export function useEngineState(engine: SyncEngine): EngineState {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.getState(),
  );
}
