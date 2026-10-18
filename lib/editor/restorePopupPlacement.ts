export type PopupViewport = { left: number; top: number; width: number; height: number };
export type PopupPlacement = { left: number; width: number; maxHeight: number; bottom: number };

/** Layout-viewport CSS pixels throughout; no media or project coordinates. */
export function restorePopupPlacement(toolbar: { top: number; right: number }, viewport: PopupViewport): PopupPlacement | null {
  if (![toolbar.top, toolbar.right, viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite) ||
    viewport.width <= 0 || viewport.height <= 0) return null;
  const margin = 12, gap = 4;
  const width = Math.min(310, viewport.width - 2 * margin);
  const bottom = Math.min(toolbar.top - gap, viewport.top + viewport.height - margin);
  const availableHeight = bottom - (viewport.top + margin);
  const rightLimit = viewport.left + viewport.width - margin - width;
  if (![width, bottom, availableHeight, rightLimit].every(Number.isFinite) || width < 160 || availableHeight < 80) return null;
  return {
    left: Math.max(viewport.left + margin, Math.min(toolbar.right - width, rightLimit)),
    width,
    // Round down so CSS subpixel sizing cannot exceed the available box.
    maxHeight: Math.floor(Math.min(320, availableHeight)),
    bottom,
  };
}
