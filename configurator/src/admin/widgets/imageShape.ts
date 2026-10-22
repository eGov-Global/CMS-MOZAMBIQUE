export const ratioLabel = (r: number) => `${Number(r.toFixed(2))}:1`;

interface ShapeRule {
  aspectRatio: number;
  aspectTolerance: number;
  minWidth: number;
  minHeight: number;
}

/** Why an image of this size is refused, or null when it fits the rule. */
export function shapeError(width: number, height: number, rule: ShapeRule): string | null {
  const ratio = width / height;
  if (!height || Math.abs(ratio - rule.aspectRatio) / rule.aspectRatio > rule.aspectTolerance) {
    return `Image must be ${ratioLabel(rule.aspectRatio)}. This one is ${width} × ${height} px (${ratioLabel(ratio)}).`;
  }
  if (width < rule.minWidth || height < rule.minHeight) {
    return `Image is too small: ${width} × ${height} px. Use at least ${rule.minWidth} × ${rule.minHeight} px.`;
  }
  return null;
}
