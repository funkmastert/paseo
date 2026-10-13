/**
 * `prompt-jump-settle.ts`'s controller assumes increasing `scrollTop` moves a
 * target row's screen position up (toward the landing position near the
 * container's top edge) -- true for a normal scroll container. This list is
 * `inverted` (RN flips it so offset 0 lands at the visual bottom), which
 * reverses that relationship: increasing `offsetY` moves a row's screen
 * position down, not up. Negating `offsetY` into a pseudo scroll-top
 * restores the sign the controller expects without changing the controller
 * itself.
 */
export function offsetYToPseudoScrollTop(offsetY: number): number {
  return offsetY === 0 ? 0 : -offsetY;
}

export function pseudoScrollTopToOffsetY(pseudoScrollTop: number): number {
  return pseudoScrollTop === 0 ? 0 : -pseudoScrollTop;
}
