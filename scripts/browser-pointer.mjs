/* global document, window */
import assert from 'node:assert/strict';
import console from 'node:console';

/** Guard only the starting point of a real pointer action; never clamp a drag. */
export async function assertPointerHit(page, target, point) {
  const viewport = page.viewportSize();
  const observation = await target.evaluate((el, { x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return { reachesTarget: !!hit && el.contains(hit), hit: hit?.className ?? null,
      scroll: { x: window.scrollX, y: window.scrollY } };
  }, point);
  console.log('POINTER_TARGET', JSON.stringify({ target: target.toString(), point, viewport, ...observation }));
  assert(viewport && point.x > 0 && point.x < viewport.width && point.y > 0 && point.y < viewport.height,
    'real pointer starting point is inside viewport');
  assert(observation.reachesTarget, 'real pointer starting point reaches the intended target');
}

export async function visiblePointerPoint(page, target, offset = {}) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert(box, 'pointer target has layout bounds');
  const point = { x: box.x + (offset.x ?? box.width / 2), y: box.y + (offset.y ?? box.height / 2) };
  await assertPointerHit(page, target, point);
  return point;
}

/** Prepare both endpoints before Playwright computes its native drag coordinates. */
export async function dragToVisibleTarget(page, source, target, options = {}) {
  await target.scrollIntoViewIfNeeded();
  await visiblePointerPoint(page, source, options.sourcePosition);
  const box = await target.boundingBox();
  assert(box, 'drag destination has layout bounds');
  const offset = options.targetPosition ?? { x: box.width / 2, y: box.height / 2 };
  await assertPointerHit(page, target, { x: box.x + offset.x, y: box.y + offset.y });
  await source.dragTo(target, options);
}
