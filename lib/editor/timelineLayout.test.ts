import { describe, expect, it } from "vitest";
import { timelineTracksAreaHeightPx, TIMELINE_RULER_HEIGHT_PX, TIMELINE_TRACK_ROW_HEIGHT_PX } from "./timelineLayout";

describe("timelineTracksAreaHeightPx", () => {
  it("returns ruler plus two track rows for default project", () => {
    expect(timelineTracksAreaHeightPx(2)).toBe(TIMELINE_RULER_HEIGHT_PX + TIMELINE_TRACK_ROW_HEIGHT_PX * 2);
  });

  it("grows when tracks are added", () => {
    expect(timelineTracksAreaHeightPx(3)).toBe(TIMELINE_RULER_HEIGHT_PX + TIMELINE_TRACK_ROW_HEIGHT_PX * 3);
  });
});
