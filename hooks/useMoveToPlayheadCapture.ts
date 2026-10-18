"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Local exclusion for the explicit placement action; existing gestures keep ownership. */
export function useMoveToPlayheadCapture() {
  const downIds = useRef(new Set<number>());
  const capturedIds = useRef(new Set<number>());
  const [active, setActive] = useState(false);
  const isActive = useCallback(() => downIds.current.size > 0 || capturedIds.current.size > 0, []);
  useEffect(() => {
    // pointerdown precedes pending capture delivery. Keep it synchronous and ref-only:
    // rendering aria-disabled here would also suppress this action's own normal click.
    const down = (event: PointerEvent) => { downIds.current.add(event.pointerId); };
    const capture = (event: PointerEvent) => { capturedIds.current.add(event.pointerId); setActive(true); };
    const lost = (event: PointerEvent) => { capturedIds.current.delete(event.pointerId); setActive(capturedIds.current.size > 0); };
    const release = (event: PointerEvent) => {
      downIds.current.delete(event.pointerId);
      capturedIds.current.delete(event.pointerId);
      setActive(capturedIds.current.size > 0);
    };
    const blur = (event: FocusEvent) => {
      // Capture-phase listeners also receive descendant focus changes. They do
      // not end a held pointer or pending capture when the action gains focus.
      if (event.target !== window) return;
      downIds.current.clear(); capturedIds.current.clear(); setActive(false);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("gotpointercapture", capture, true);
    window.addEventListener("lostpointercapture", lost, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", blur, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("gotpointercapture", capture, true);
      window.removeEventListener("lostpointercapture", lost, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", blur, true);
      downIds.current.clear();
      capturedIds.current.clear();
    };
  }, []);
  return { active, isActive };
}
