export const TIMELINE_RULER_HEIGHT_PX = 28;
export const TIMELINE_TRACK_ROW_HEIGHT_PX = 64;
export const TIMELINE_LABEL_WIDTH_PX = 48;

export function timelineTracksAreaHeightPx(trackCount: number): number {
  return TIMELINE_RULER_HEIGHT_PX + trackCount * TIMELINE_TRACK_ROW_HEIGHT_PX;
}
