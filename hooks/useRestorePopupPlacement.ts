"use client";

import { useLayoutEffect, type RefObject } from "react";
import { restorePopupPlacement } from "@/lib/editor/restorePopupPlacement";

const SPACE_ERROR = "説明を表示する領域が不足しています。画面をスクロールするか高さを調整してください。";
const PLACEMENT_ERROR = "説明の配置に失敗しました。画面をスクロールするか高さを調整してください。";

function hasFixedContainingBlock(panel: HTMLElement): boolean {
  for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.transform !== "none" || style.perspective !== "none" || style.filter !== "none" ||
      (style.backdropFilter && style.backdropFilter !== "none") ||
      [style.translate, style.rotate, style.scale].some(value => value && value !== "none") ||
      /(?:layout|paint|strict|content)/.test(style.contain) ||
      /(?:transform|perspective|filter|contain)/.test(style.willChange) ||
      (style.contentVisibility && style.contentVisibility !== "visible")) return true;
  }
  return false;
}

/** Own only the existing popup's viewport placement, never its metadata or open state. */
export function useRestorePopupPlacement(
  toolbarRef: RefObject<HTMLDivElement | null>, detailsRef: RefObject<HTMLDetailsElement | null>, epoch: number,
) {
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current, details = detailsRef.current;
    const panel = details?.querySelector<HTMLElement>("[data-restore-input-audio]");
    const summary = details?.querySelector<HTMLElement>("summary");
    if (!toolbar || !details || !panel || !summary) return;
    const originalTitle = summary.getAttribute("title"), originalDescription = summary.getAttribute("aria-description");
    const properties = ["width", "max-height", "left", "top"] as const;
    const originalStyles = properties.map(name => [name, panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)] as const);
    const originalInert = panel.inert;
    let disposed = false, active = false, generation = 0, pending: number | null = null;
    let resizeObserver: ResizeObserver | null = null, contentObserver: MutationObserver | null = null;
    const viewport = window.visualViewport;
    const sameOwner = () => !disposed && toolbarRef.current === toolbar && detailsRef.current === details &&
      toolbar.isConnected && details.isConnected && panel.isConnected && details.contains(panel);
    const setAttribute = (element: HTMLElement, name: string, value: string | null) => {
      if (element.getAttribute(name) === value) return;
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    };
    const restoreExplanation = () => {
      setAttribute(summary, "title", originalTitle);
      setAttribute(summary, "aria-description", originalDescription);
    };
    const hide = (message?: string) => {
      setAttribute(panel, "data-popup-positioned", null);
      if (!panel.inert) panel.inert = true;
      if (message) {
        setAttribute(summary, "title", message);
        setAttribute(summary, "aria-description", message);
      } else restoreExplanation();
    };
    const write = (name: string, value: number) => {
      const text = `${value}px`;
      if (panel.style.getPropertyValue(name) !== text) panel.style.setProperty(name, text);
    };
    const measure = () => {
      if (!sameOwner() || !details.open) return;
      if (hasFixedContainingBlock(panel)) { hide(PLACEMENT_ERROR); return; }
      const visible = viewport ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
        : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const toolbarBox = toolbar.getBoundingClientRect();
      if (![toolbarBox.top, toolbarBox.right, ...Object.values(visible)].every(Number.isFinite)) { hide(PLACEMENT_ERROR); return; }
      const placement = restorePopupPlacement(toolbarBox, visible);
      if (!placement) { hide(SPACE_ERROR); return; }
      // Valid remeasurement keeps visibility/inert unchanged, preserving copy/Tab focus.
      write("width", placement.width);
      write("max-height", placement.maxHeight);
      const height = panel.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height <= 0 || height > placement.maxHeight) { hide(PLACEMENT_ERROR); return; }
      // Ceil the measured height only for the top coordinate: remain conservatively above the anchor.
      write("left", placement.left);
      write("top", placement.bottom - Math.ceil(height));
      const box = panel.getBoundingClientRect();
      if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite) ||
        box.left < visible.left + 12 || box.right > visible.left + visible.width - 12 ||
        box.top < visible.top + 12 || box.bottom > placement.bottom || box.bottom > toolbarBox.top - 4) {
        hide(PLACEMENT_ERROR); return;
      }
      restoreExplanation();
      setAttribute(panel, "data-popup-positioned", "true");
      if (panel.inert) panel.inert = false;
    };
    const schedule = () => {
      if (!active || !sameOwner() || !details.open || pending !== null) return;
      const expectedGeneration = generation;
      pending = requestAnimationFrame(() => {
        pending = null;
        if (active && sameOwner() && details.open && generation === expectedGeneration) measure();
      });
    };
    const stop = () => {
      active = false;
      generation++;
      if (pending !== null) cancelAnimationFrame(pending);
      pending = null;
      resizeObserver?.disconnect(); resizeObserver = null;
      contentObserver?.disconnect(); contentObserver = null;
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      hide();
      for (const [name, value, priority] of originalStyles) {
        if (value) panel.style.setProperty(name, value, priority); else panel.style.removeProperty(name);
      }
    };
    const toggle = () => {
      if (!sameOwner() || !details.open) { stop(); return; }
      if (!active) {
        active = true;
        generation++;
        hide();
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        viewport?.addEventListener("resize", schedule);
        viewport?.addEventListener("scroll", schedule);
        resizeObserver = new ResizeObserver(schedule);
        const shell = toolbar.closest(".editor-shell-v2");
        for (const element of [toolbar, panel, toolbar.closest(".editor-timeline-pane"), shell?.querySelector(".editor-workspace-pane")]) {
          if (element) resizeObserver.observe(element);
        }
        // Text/children only: never observe the owner's style/inert/position attributes.
        contentObserver = new MutationObserver(schedule);
        contentObserver.observe(panel, { subtree: true, childList: true, characterData: true });
      }
      schedule();
    };
    hide();
    details.addEventListener("toggle", toggle);
    toggle();
    return () => {
      stop();
      disposed = true;
      details.removeEventListener("toggle", toggle);
      panel.inert = originalInert;
    };
  }, [toolbarRef, detailsRef, epoch]);
}
