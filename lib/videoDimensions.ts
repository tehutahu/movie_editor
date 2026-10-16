type Dimensions = { width?: number; height?: number };
export type VideoDisplayStream = Dimensions & {
  side_data_list?: { side_data_type?: string; rotation?: unknown }[];
};

/** Encoded dimensions stay available for legacy project validation. Only the
 * display matrix's known quarter turns affect the new asset's display size.
 * SAR, arbitrary angles and legacy rotate tags are deliberately not inferred.
 */
export function videoDisplayDimensions(stream: VideoDisplayStream): Dimensions {
  const { width, height } = stream;
  const rotation = stream.side_data_list?.find(
    (data) => data.side_data_type === "Display Matrix",
  )?.rotation;
  if (
    typeof rotation === "number" &&
    Number.isFinite(rotation) &&
    rotation % 90 === 0 &&
    Math.abs(rotation % 180) === 90
  ) {
    return { width: height, height: width };
  }
  return { width, height };
}

/** v1 documents may contain the old encoded pair or the new display pair.
 * Match each complete pair from this file; never accept arbitrary swapping or
 * combine one encoded dimension with one display dimension. Keep the existing
 * raw check for documents whose optional dimensions are absent/partial.
 */
export function matchesMediaDimensions(
  saved: Dimensions,
  actual: Dimensions & { displayWidth?: number; displayHeight?: number },
): boolean {
  const rawMatch =
    (saved.width === undefined || saved.width === actual.width) &&
    (saved.height === undefined || saved.height === actual.height);
  const displayMatch =
    saved.width !== undefined && saved.height !== undefined &&
    actual.displayWidth !== undefined && actual.displayHeight !== undefined &&
    saved.width === actual.displayWidth && saved.height === actual.displayHeight;
  return rawMatch || displayMatch;
}
