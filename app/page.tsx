"use client";

import { EditorShell } from "@/components/editor/EditorShell";
import { useEditorStore } from "@/hooks/useEditorStore";

export default function HomePage() {
  const editor = useEditorStore();
  return <EditorShell editor={editor} />;
}
