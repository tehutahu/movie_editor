"use client";

import { EditorLayout } from "@/components/editor/EditorLayout";
import { useEditorState } from "@/hooks/useEditorState";

export default function HomePage() {
  const editor = useEditorState();
  return <EditorLayout editor={editor} />;
}
