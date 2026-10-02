(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WordExplainerPositioning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(value, min, max) {
    const safeMax = Math.max(min, max);
    return Math.min(safeMax, Math.max(min, value));
  }

  function calculatePopoverPlacement(options) {
    const viewportWidth = Math.max(1, Number(options.viewportWidth) || 1);
    const viewportHeight = Math.max(1, Number(options.viewportHeight) || 1);
    const gap = Math.max(0, Number(options.gap) || 0);
    const edgePadding = Math.max(0, Number(options.edgePadding) || 0);
    const anchor = options.anchor || {};
    let width = Math.min(Math.max(1, Number(options.width) || 1), viewportWidth);
    let height = Math.min(Math.max(1, Number(options.height) || 1), viewportHeight);
    const safeAnchor = {
      left: Number.isFinite(anchor.left) ? anchor.left : viewportWidth / 2,
      right: Number.isFinite(anchor.right) ? anchor.right : viewportWidth / 2,
      top: Number.isFinite(anchor.top) ? anchor.top : viewportHeight / 2,
      bottom: Number.isFinite(anchor.bottom) ? anchor.bottom : viewportHeight / 2,
      preferVertical: anchor.preferVertical === true,
    };
    const spaces = {
      below: Math.max(0, viewportHeight - edgePadding - safeAnchor.bottom - gap),
      above: Math.max(0, safeAnchor.top - edgePadding - gap),
      right: Math.max(0, viewportWidth - edgePadding - safeAnchor.right - gap),
      left: Math.max(0, safeAnchor.left - edgePadding - gap),
    };

    let side;
    let autoFitHeight = false;
    let autoFitWidth = false;
    if (spaces.below >= height) side = 'below';
    else if (spaces.above >= height) side = 'above';
    else if (safeAnchor.preferVertical && Math.max(spaces.below, spaces.above) >= 120) {
      side = spaces.below >= spaces.above ? 'below' : 'above';
      height = spaces[side];
      autoFitHeight = true;
    } else if (spaces.right >= width) side = 'right';
    else if (spaces.left >= width) side = 'left';
    else {
      const verticalSide = spaces.below >= spaces.above ? 'below' : 'above';
      const horizontalSide = spaces.right >= spaces.left ? 'right' : 'left';
      const verticalSpace = spaces[verticalSide];
      const horizontalSpace = spaces[horizontalSide];
      if (verticalSpace >= 120 || verticalSpace / height >= horizontalSpace / width) {
        side = verticalSide;
        if (verticalSpace >= 120 && verticalSpace < height) {
          height = verticalSpace;
          autoFitHeight = true;
        }
      } else {
        side = horizontalSide;
        if (horizontalSpace >= 240 && horizontalSpace < width) {
          width = horizontalSpace;
          autoFitWidth = true;
        }
      }
    }

    const maxLeft = Math.max(edgePadding, viewportWidth - edgePadding - width);
    const maxTop = Math.max(edgePadding, viewportHeight - edgePadding - height);
    const anchorCenterX = (safeAnchor.left + safeAnchor.right) / 2;
    const anchorCenterY = (safeAnchor.top + safeAnchor.bottom) / 2;
    let left = clamp(anchorCenterX - width / 2, edgePadding, maxLeft);
    let top = clamp(anchorCenterY - height / 2, edgePadding, maxTop);

    if (side === 'below') top = safeAnchor.bottom + gap;
    else if (side === 'above') top = safeAnchor.top - gap - height;
    else if (side === 'right') left = safeAnchor.right + gap;
    else if (side === 'left') left = safeAnchor.left - gap - width;

    return { side, left, top, width, height, autoFitHeight, autoFitWidth, spaces };
  }

  function rectanglesOverlap(first, second, clearance = 0) {
    if (!first || !second) return false;
    const gap = Math.max(0, Number(clearance) || 0);
    return !(
      first.bottom + gap <= second.top
      || first.top >= second.bottom + gap
      || first.right + gap <= second.left
      || first.left >= second.right + gap
    );
  }

  // 整组平移，避免分别钳制时多个按钮堆叠；预留 hover 和弹跳动画空间。
  function calculateTriggerOrigin({ x, y, offsets, viewportWidth, viewportHeight, radius = 26 }) {
    const minDx = Math.min(0, ...offsets.map((item) => item.dx * 1.08));
    const maxDx = Math.max(0, ...offsets.map((item) => item.dx * 1.08));
    const minDy = Math.min(0, ...offsets.map((item) => item.dy * 1.08));
    const maxDy = Math.max(0, ...offsets.map((item) => item.dy * 1.08));
    return {
      x: clamp(x, radius - minDx, viewportWidth - radius - maxDx),
      y: clamp(y, radius - minDy, viewportHeight - radius - maxDy),
    };
  }

  return { calculatePopoverPlacement, calculateTriggerOrigin, rectanglesOverlap };
});
