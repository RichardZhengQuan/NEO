/** Geometry is based on the figure frame, never the portal host's box. */
export interface OrbitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OrbitEllipse { x: number; y: number; rx: number; ry: number }

export interface AvatarOrbitGeometry {
  bounds: OrbitRect;
  portrait: OrbitEllipse;
  portraitRadius: number;
  focusedPortraitMinY: number | null;
}

function usable(rect: OrbitRect | null | undefined): rect is OrbitRect {
  return !!rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

/**
 * The frame describes the rendered artwork. A display:contents portal host can
 * have a zero box; use the stage (or viewport while it lays out), or wait for a
 * valid measurement instead of drawing a collapsed ellipse.
 */
export function avatarOrbitGeometry(props: {
  frame?: OrbitRect | null;
  area?: OrbitRect | null;
  viewport?: OrbitRect | null;
  clearance?: OrbitRect | null;
}): AvatarOrbitGeometry | null {
  const bounds = usable(props.area) ? props.area : usable(props.viewport) ? props.viewport : null;
  if (!bounds) return null;
  const figure = usable(props.frame) ? props.frame : props.frame ? null : bounds;
  if (!figure) return null;
  const mobile = bounds.width < 900;
  const radius = mobile ? 28 : 32;
  const width = figure.width;
  const height = figure.height;
  const x = figure.left - bounds.left + width / 2;
  const top = figure.top - bounds.top;
  const card = !mobile && usable(props.clearance) ? props.clearance : null;

  const availableRadius = (y: number, ry: number, targetRadius: number): number => {
    // Include the complete keyboard outline, even when a rear target is lifted.
    const padding = targetRadius + 12;
    let available = Math.min(x, bounds.width - x) - padding;
    if (card) {
      const cardTop = card.top - bounds.top;
      const cardBottom = cardTop + card.height;
      const gap = targetRadius + 6 + 24;
      // A bottom-right poster does not constrain the torso orbit above it.
      const low = Math.max(-1, (cardTop - gap - y) / ry);
      const high = Math.min(1, (cardBottom + gap - y) / ry);
      if (low < high) {
        const cardOnRight = card.left + card.width / 2 > bounds.left + x;
        const cardSpace = cardOnRight
          ? card.left - bounds.left - x
          : x - (card.left + card.width - bounds.left);
        // Near the top/bottom arc, the ellipse never reaches its full width.
        // Reserve the card's expanded rectangle only at intersecting heights.
        const closestToCenter = low > 0 ? low : high < 0 ? high : 0;
        const horizontalReach = Math.sqrt(1 - closestToCenter * closestToCenter);
        available = Math.min(available, (cardSpace - gap) / horizontalReach);
      }
    }
    return Math.max(0, available);
  };

  const portraitRy = width * .2;
  const portraitY = top + height * .48;
  const portraitRx = Math.min(width * .825, availableRadius(portraitY, portraitRy, radius));
  if (portraitRx <= 0) return null;

  return {
    bounds,
    portrait: { x, y: portraitY, rx: portraitRx, ry: portraitRy },
    portraitRadius: radius,
    focusedPortraitMinY: card ? top + height * .42 + radius + 6 + 2 : null,
  };
}
