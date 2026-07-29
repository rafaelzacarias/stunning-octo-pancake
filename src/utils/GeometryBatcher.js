import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * GeometryBatcher — collapses many static props sharing a material into a
 * single merged mesh.
 *
 * The factory has hundreds of small pieces (truss webs, conveyor legs, motor
 * fins, scrap piles). Each one is a draw call in the beauty pass *and* again
 * in every shadow map. Batching them is the difference between ~550 and ~60
 * draw calls per frame.
 */
export class GeometryBatcher {
  constructor() {
    /** @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
    this.batches = new Map();
    this._m = new THREE.Matrix4();
  }

  /**
   * @param {THREE.BufferGeometry} geometry  source geometry (not consumed)
   * @param {THREE.Material} material
   * @param {THREE.Vector3|number[]} position
   * @param {THREE.Euler|number[]} [rotation]
   * @param {THREE.Vector3|number} [scale]
   */
  add(geometry, material, position, rotation, scale) {
    const g = normalise(geometry.clone());

    const p = toVec(position);
    const r = rotation
      ? (rotation.isEuler ? rotation : new THREE.Euler(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0))
      : new THREE.Euler();
    const s = scale === undefined
      ? new THREE.Vector3(1, 1, 1)
      : (typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : toVec(scale));

    this._m.compose(p, new THREE.Quaternion().setFromEuler(r), s);
    g.applyMatrix4(this._m);

    let list = this.batches.get(material);
    if (!list) { list = []; this.batches.set(material, list); }
    list.push(g);
    return this;
  }

  /**
   * Merge every batch and attach the result to `parent`.
   * @returns {THREE.Mesh[]}
   */
  flush(parent, { castShadow = true, receiveShadow = true, namePrefix = 'batch' } = {}) {
    const meshes = [];
    let i = 0;
    for (const [material, list] of this.batches) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `${namePrefix}-${i++}`;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.batches.clear();
    return meshes;
  }
}

function toVec(v) {
  if (v === undefined) return new THREE.Vector3();
  return v.isVector3 ? v.clone() : new THREE.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
}

/** mergeGeometries() demands a uniform attribute set and index state. */
function normalise(g) {
  let out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(
      new Float32Array(out.attributes.position.count * 2), 2
    ));
  }
  // Drop anything else so every part in a batch matches exactly.
  for (const key of Object.keys(out.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') out.deleteAttribute(key);
  }
  return out;
}
