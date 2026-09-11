/** Point-in-cell test on the convex Cell BSP (ACE BSPNode.point_inside_cell_bsp). */
import type { BSPNode, CellStruct } from "../dat/mod.ts";

const TAG_LEAF = 0x4c454146;
const EPSILON = 0.0002;

function inside(node: BSPNode, x: number, y: number, z: number): boolean {
  if (node.tag === TAG_LEAF || !node.plane) return true;
  const d = node.plane.n.x * x + node.plane.n.y * y + node.plane.n.z * z + node.plane.d;
  if (d >= -EPSILON) return node.pos ? inside(node.pos, x, y, z) : true;
  return false;
}

/** `point` must be in the cell's local space (inverse of the EnvCell frame). */
export function pointInsideCell(cs: CellStruct, x: number, y: number, z: number): boolean {
  return inside(cs.cellBSP, x, y, z);
}
