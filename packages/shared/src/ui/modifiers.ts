import type { Modifier } from "@dnd-kit/core";

/** Rows only move up and down (avoids pulling in @dnd-kit/modifiers for one function). */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
