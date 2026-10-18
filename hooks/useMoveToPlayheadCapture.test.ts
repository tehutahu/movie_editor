import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ cleanup: undefined as undefined | (() => void), state: false }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: () => [false, (active: boolean) => { harness.state = active; }],
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => (() => void)) => { harness.cleanup = effect(); },
}));
import { useMoveToPlayheadCapture } from "./useMoveToPlayheadCapture";
const listeners = new Map<string, EventListener>();
const owner = {
  addEventListener: (name: string, listener: EventListener) => { listeners.set(name, listener); },
  removeEventListener: (name: string, listener: EventListener) => { expect(listeners.get(name)).toBe(listener); listeners.delete(name); },
};
function dispatch(name: string, target: unknown = owner, pointerId = 1) {
  const event = { target, pointerId } as unknown as Event;
  listeners.get(name)!(event);
}
beforeEach(() => { listeners.clear(); harness.state = false; harness.cleanup = undefined; vi.stubGlobal("window", owner); });
afterEach(() => { harness.cleanup?.(); vi.unstubAllGlobals(); });
it("internal focus blur preserves a stationary down before capture delivery", () => {
  const capture = useMoveToPlayheadCapture();
  dispatch("pointerdown"); expect(capture.isActive()).toBe(true);
  expect(harness.state).toBe(false); // A normal action button is not disabled on down.
  dispatch("blur", { tagName: "BUTTON" });
  expect(capture.isActive()).toBe(true); // Event-time keyboard adoption must reject.
  dispatch("pointerup"); expect(capture.isActive()).toBe(false); // Normal click may adopt.
});
it("internal focus blur retains delivered capture until capture ownership ends", () => {
  const capture = useMoveToPlayheadCapture();
  dispatch("pointerdown"); dispatch("gotpointercapture");
  dispatch("blur", { tagName: "INPUT" }); expect(capture.isActive()).toBe(true); expect(harness.state).toBe(true);
  dispatch("lostpointercapture"); expect(capture.isActive()).toBe(true); // Down is still held.
  dispatch("pointercancel"); expect(capture.isActive()).toBe(false); expect(harness.state).toBe(false);
});
it("actual window blur clears all pointers and captured UI state", () => {
  const capture = useMoveToPlayheadCapture();
  dispatch("pointerdown"); dispatch("gotpointercapture"); dispatch("pointerdown", owner, 2);
  dispatch("blur"); expect(capture.isActive()).toBe(false); expect(harness.state).toBe(false);
});
it("unmount removes every listener and clears held pointer ownership", () => {
  const capture = useMoveToPlayheadCapture(); dispatch("pointerdown"); dispatch("gotpointercapture");
  harness.cleanup!(); harness.cleanup = undefined;
  expect(capture.isActive()).toBe(false); expect(listeners.size).toBe(0);
});
