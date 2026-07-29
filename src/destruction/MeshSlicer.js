/**
 * CONTRACT (owned by the Physics sub-agent).
 * Splits a BufferGeometry by a plane, capping the cut with a triangulated
 * polygon and tagging the seam vertices for the shear-heat shader.
 */
export function sliceGeometry(_geometry, _plane, _opts) {
  return { above: null, below: null, area: 0 };
}

export function convexHullPoints(geometry) {
  return geometry.getAttribute('position').array;
}
