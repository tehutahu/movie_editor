import type { EditorProject } from "@/lib/editor/types";
import { applyCommand, type EditorCommand } from "@/lib/editor/commands";

export type CommandHistory = {
  undoStack: EditorProject[];
  redoStack: EditorProject[];
};

export function createCommandHistory(initial: EditorProject): CommandHistory {
  return { undoStack: [initial], redoStack: [] };
}

export function getCurrentProject(history: CommandHistory): EditorProject {
  return history.undoStack[history.undoStack.length - 1]!;
}

export function dispatchCommand(
  history: CommandHistory,
  command: EditorCommand,
): { history: CommandHistory; project: EditorProject } | null {
  const current = getCurrentProject(history);
  const next = applyCommand(current, command);
  if (!next) return null;
  return {
    history: {
      undoStack: [...history.undoStack, next],
      redoStack: [],
    },
    project: next,
  };
}

export function undo(history: CommandHistory): CommandHistory | null {
  if (history.undoStack.length <= 1) return null;
  const current = history.undoStack[history.undoStack.length - 1]!;
  const undoStack = history.undoStack.slice(0, -1);
  return {
    undoStack,
    redoStack: [current, ...history.redoStack],
  };
}

export function redo(history: CommandHistory): CommandHistory | null {
  if (history.redoStack.length === 0) return null;
  const [next, ...rest] = history.redoStack;
  return {
    undoStack: [...history.undoStack, next!],
    redoStack: rest,
  };
}

export function replaceProject(
  history: CommandHistory,
  project: EditorProject,
): CommandHistory {
  return {
    undoStack: [...history.undoStack.slice(0, -1), project],
    redoStack: [],
  };
}

export function canUndo(history: CommandHistory): boolean {
  return history.undoStack.length > 1;
}

export function canRedo(history: CommandHistory): boolean {
  return history.redoStack.length > 0;
}
