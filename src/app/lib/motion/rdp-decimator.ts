/**
 * Ramer-Douglas-Peucker polyline simplification.
 *
 * Reduces a dense time-value curve (e.g. 150 frames at 30 fps) to a sparse
 * set of keyframes that retain the perceptually significant inflection points.
 *
 * epsilon controls fidelity:
 *   0.005 — very faithful, ~10-20 keyframes
 *   0.015 — good balance (default), ~4-8 keyframes
 *   0.04  — aggressive simplification, ~2-4 keyframes
 */

export interface RdpPoint {
    /** Normalized time 0..1 */
    t: number;
    /** Channel value (morph weight 0..1 or radians for bones) */
    v: number;
}

function perpendicularDistance(p: RdpPoint, start: RdpPoint, end: RdpPoint): number {
    const dx = end.t - start.t;
    const dy = end.v - start.v;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
        // start === end: use Euclidean distance to start
        return Math.sqrt((p.t - start.t) ** 2 + (p.v - start.v) ** 2);
    }
    // Signed perpendicular distance using the cross-product formula
    return Math.abs(dx * (start.v - p.v) - (start.t - p.t) * dy) / Math.sqrt(len2);
}

export function rdpDecimate(points: RdpPoint[], epsilon: number): RdpPoint[] {
    if (points.length <= 2) return [...points];

    // Find the point with the maximum distance from the line start→end
    let maxDist = 0;
    let maxIdx = 0;
    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const d = perpendicularDistance(points[i], first, last);
        if (d > maxDist) {
            maxDist = d;
            maxIdx = i;
        }
    }

    if (maxDist > epsilon) {
        // Recursive simplification on both halves
        const left = rdpDecimate(points.slice(0, maxIdx + 1), epsilon);
        const right = rdpDecimate(points.slice(maxIdx), epsilon);
        // Merge, avoiding the duplicate at maxIdx
        return [...left.slice(0, -1), ...right];
    }

    // The whole segment is flat enough — keep only endpoints
    return [first, last];
}

/**
 * Convenience: decimate and ensure the result always starts at t=0 and ends at t=1.
 * Appends anchor points if the RDP result dropped them.
 */
export function decimateChannel(rawPoints: RdpPoint[], epsilon: number): RdpPoint[] {
    if (rawPoints.length === 0) return [{ t: 0, v: 0 }, { t: 1, v: 0 }];
    const result = rdpDecimate(rawPoints, epsilon);
    // Guarantee t=0 anchor
    if (result[0].t > 0) result.unshift({ t: 0, v: rawPoints[0].v });
    // Guarantee t=1 anchor
    if (result[result.length - 1].t < 1) result.push({ t: 1, v: rawPoints[rawPoints.length - 1].v });
    return result;
}
