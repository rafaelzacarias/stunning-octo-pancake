/**
 * CONTRACT (owned by the Physics sub-agent).
 * Plastic (permanent) deformation applied before a part actually shears.
 */
export class Deformer {
  static dent(_geometry, _localPoint, _localDir, _radius, _depth) { return 0; }
}
