/**
 * IronBend Shape Renderer v1.0
 * SVG-based 2D and isometric-3D rebar shape visualization.
 *
 * Usage:
 *   renderShape2D(container, sides, angles, opts)
 *   renderShape3D(container, sides, angles, opts)
 *
 * sides  — array of leg lengths in mm  e.g. [300, 600, 300]
 * angles — array of bend angles (degrees, interior angle)  e.g. [90, 90]
 *          bend angle 90° = perpendicular turn (L, U, stirrup)
 *          bend angle 135° = gentle diagonal turn (Z, S)
 *          bend angle 180° = straight (no visible bend)
 *
 * Angle convention: each angle is the INTERIOR bend angle.
 * Turn amount = 180° - bend_angle  (counterclockwise from current direction)
 * Exception: for angles > 180° the shape bends clockwise (hooks).
 */

(function(global) {
  const NS = 'http://www.w3.org/2000/svg';

  // The shape data contract stores lengths in millimetres. Keep every visual
  // label in centimetres, matching the editor and the order text around it.
  function formatLengthCmFromMm(value) {
    const millimetres = Number(value);
    if (!Number.isFinite(millimetres)) return '—';
    if (global.IronBendDisplayUnits?.formatLengthCmFromMm) {
      return global.IronBendDisplayUnits.formatLengthCmFromMm(millimetres, {
        maximumFractionDigits: 1,
        useGrouping: false,
      });
    }
    const centimetres = Math.round(millimetres) / 10;
    return `${Number(centimetres.toFixed(1)).toLocaleString('he-IL', { maximumFractionDigits: 1, useGrouping: false })} ס״מ`;
  }

  function dimensionTagWidth(value, min = 44, max = 76) {
    return Math.max(min, Math.min(max, String(value).length * 6.4 + 16));
  }

  /* ── compute path points ───────────────────────────────────── */
  function computePoints(sides, angles) {
    const pts = [{x:0, y:0}];
    let dir = 0; // radians, 0 = rightward
    for (let i = 0; i < sides.length; i++) {
      const last = pts[pts.length - 1];
      const len  = sides[i] || 0;
      pts.push({
        x: last.x + Math.cos(dir) * len,
        y: last.y - Math.sin(dir) * len   // SVG y-axis is inverted
      });
      if (i < angles.length) {
        const bendAngle = angles[i]; // interior angle in degrees
        const turn = (180 - bendAngle) * Math.PI / 180; // radians to turn CCW
        dir += turn;
      }
    }
    return pts;
  }

  function isRightAngle(value) {
    return Math.abs(Number(value) - 90) < 0.1;
  }

  function isSimilarDimension(a, b, tolerance) {
    const max = Math.max(Number(a) || 0, Number(b) || 0);
    if (max <= 0) return false;
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= Math.max(10, max * (tolerance || 0.12));
  }

  function closedStirrupParts(sides, angles) {
    if (!Array.isArray(sides) || sides.length < 4) return null;
    const lengths = sides.map(n => Number(n) || 0);
    if (lengths.some(n => n <= 0)) return null;
    const checkedAngles = (angles || []).slice(0, Math.min(4, lengths.length - 1));
    if (checkedAngles.length && !checkedAngles.every(isRightAngle)) return null;

    if (lengths.length >= 5) {
      const [sideA, tailStart, horizontalA, tailEnd, horizontalB, sideB] = lengths;
      const maxBody = Math.max(sideA, horizontalA, horizontalB, sideB || sideA);
      if (
        tailStart <= maxBody * 0.6 &&
        (!tailEnd || tailEnd <= maxBody * 0.6) &&
        isSimilarDimension(sideA, sideB || sideA) &&
        isSimilarDimension(horizontalA, horizontalB)
      ) {
        return { top: horizontalA, right: sideA, bottom: horizontalB, left: sideB || sideA, tailStart, tailEnd };
      }
    }

    const [top, right, bottom, left] = lengths;
    if (isSimilarDimension(top, bottom) && isSimilarDimension(right, left)) {
      return { top, right, bottom, left, tailStart: lengths[4] || 0, tailEnd: 0 };
    }

    return null;
  }

  function addShapeText(svg, text, x, y, attrs) {
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', x.toFixed(1));
    label.setAttribute('y', y.toFixed(1));
    label.setAttribute('text-anchor', attrs && attrs.anchor || 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('fill', attrs && attrs.fill || '#526070');
    label.setAttribute('font-size', attrs && attrs.size || '9');
    label.setAttribute('font-family', attrs && attrs.font || 'monospace');
    label.setAttribute('font-weight', attrs && attrs.weight || '700');
    label.textContent = text;
    svg.appendChild(label);
  }

  function renderClosedStirrup2D(svg, parts, W, H, opts) {
    const strokeColor = opts.color || '#c9621a';
    const strokeW = opts.strokeWidth || 4;
    const horizontal = Math.max(parts.top || 0, parts.bottom || 0, 1);
    const vertical = Math.max(parts.left || 0, parts.right || 0, 1);
    const maxBoxW = Math.max(66, W - 86);
    const maxBoxH = Math.max(58, H - 62);
    const ratio = horizontal / vertical;
    const boxW = ratio >= 1 ? maxBoxW : Math.max(58, Math.min(maxBoxW, maxBoxH * ratio));
    const boxH = ratio >= 1 ? Math.max(58, Math.min(maxBoxH, maxBoxW / ratio)) : maxBoxH;
    const x = (W - boxW) / 2 - 10;
    const y = (H - boxH) / 2 + 4;
    const right = x + boxW;
    const bottom = y + boxH;
    const pathD = `M ${x.toFixed(1)},${y.toFixed(1)} L ${right.toFixed(1)},${y.toFixed(1)} L ${right.toFixed(1)},${bottom.toFixed(1)} L ${x.toFixed(1)},${bottom.toFixed(1)} Z`;

    const glow = document.createElementNS(NS, 'path');
    glow.setAttribute('d', pathD);
    glow.setAttribute('stroke', strokeColor);
    glow.setAttribute('stroke-opacity', '0.18');
    glow.setAttribute('stroke-width', strokeW + 6);
    glow.setAttribute('fill', 'none');
    glow.setAttribute('stroke-linecap', 'round');
    glow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(glow);

    const base = document.createElementNS(NS, 'path');
    base.setAttribute('d', pathD);
    base.setAttribute('stroke', '#7a3a08');
    base.setAttribute('stroke-width', strokeW + 1);
    base.setAttribute('fill', 'none');
    base.setAttribute('stroke-linecap', 'round');
    base.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(base);

    const bar = document.createElementNS(NS, 'path');
    bar.setAttribute('d', pathD);
    bar.setAttribute('stroke', strokeColor);
    bar.setAttribute('stroke-width', strokeW);
    bar.setAttribute('fill', 'none');
    bar.setAttribute('stroke-linecap', 'round');
    bar.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(bar);

    const markerSize = Math.min(30, Math.max(14, Math.min(boxW, boxH) * 0.28));
    const markerX = right - markerSize;
    const markerY = y + markerSize;
    const marker = document.createElementNS(NS, 'path');
    marker.setAttribute('data-stirrup-marker', 'overlap');
    marker.setAttribute('d', `M ${right.toFixed(1)},${y.toFixed(1)} L ${markerX.toFixed(1)},${y.toFixed(1)} L ${markerX.toFixed(1)},${markerY.toFixed(1)} L ${right.toFixed(1)},${markerY.toFixed(1)}`);
    marker.setAttribute('stroke', '#1a2533');
    marker.setAttribute('stroke-width', Math.max(3, strokeW));
    marker.setAttribute('fill', 'none');
    marker.setAttribute('stroke-linecap', 'square');
    marker.setAttribute('stroke-linejoin', 'miter');
    svg.appendChild(marker);

    if (opts.showDimensions) {
      const midX = x + boxW / 2;
      const midY = y + boxH / 2;
      addShapeText(svg, formatLengthCmFromMm(parts.top), midX, Math.max(12, y - 12), { fill: '#1a2533', size: '10', weight: '800' });
      addShapeText(svg, formatLengthCmFromMm(parts.bottom), midX, Math.min(H - 10, bottom + 14), { fill: '#1a2533', size: '10', weight: '800' });
      addShapeText(svg, formatLengthCmFromMm(parts.left), Math.max(20, x - 24), midY, { fill: '#1a2533', size: '10', weight: '800' });
      addShapeText(svg, formatLengthCmFromMm(parts.right), Math.min(W - 20, right + 24), midY, { fill: '#1a2533', size: '10', weight: '800' });
    }
  }

  /* ── fit points to a viewport ──────────────────────────────── */
  function fitPoints(pts, W, H, pad) {
    if (pts.length < 2) return {pts, scale:1, ox:pad, oy:pad};
    let minX = Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
    const scale = Math.min((W - pad*2) / dx, (H - pad*2) / dy);
    const ox = (W - dx * scale) / 2 - minX * scale;
    const oy = (H - dy * scale) / 2 - minY * scale;
    return { pts: pts.map(p => ({x: p.x*scale+ox, y: p.y*scale+oy})), scale, ox, oy };
  }

  function readableDisplaySides(sides, opts) {
    const values = (sides || []).map(n => Number(n) || 0);
    if (opts && opts.readableScale === false) return values;
    const positive = values.filter(n => n > 0);
    if (positive.length < 2) return values;
    const max = Math.max(...positive);
    const min = Math.min(...positive);
    if (!max || min / max >= 0.24) return values;

    // Human-readable preview: keep tiny hook/end legs visible.
    // Machine values still come from the labels/data, not from the drawn pixel ratio.
    return values.map(n => {
      if (n <= 0) return 0;
      return Math.max(max * 0.26, Math.sqrt(n / max) * max);
    });
  }

  /* ── 2D renderer ──────────────────────────────────────────── */
  function renderShape2D(container, sides, angles, opts) {
    if (!container) return;
    opts = opts || {};
    const W   = opts.width  || 200;
    const H   = opts.height || 140;
    const pad = opts.padding || 20;
    const strokeColor = opts.color || '#c9621a';
    const strokeW     = opts.strokeWidth || 3;

    // Clear
    container.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width',  W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = '100%';

    // Background
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', W); bg.setAttribute('height', H);
    bg.setAttribute('fill', opts.bgColor || '#f8fafc');
    bg.setAttribute('rx', 6);
    svg.appendChild(bg);

    if (!sides || sides.length === 0) {
      // Empty shape placeholder
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', W/2); t.setAttribute('y', H/2+5);
      t.setAttribute('text-anchor','middle');
      t.setAttribute('fill','#8fa0b0'); t.setAttribute('font-size','12');
      t.textContent = 'אין צורה';
      svg.appendChild(t);
      container.appendChild(svg);
      return;
    }

    const stirrup = closedStirrupParts(sides, angles || []);
    if (stirrup) {
      svg.setAttribute('data-shape-kind', 'closed-stirrup');
      renderClosedStirrup2D(svg, stirrup, W, H, opts);
      container.appendChild(svg);
      return;
    }

    const displaySides = readableDisplaySides(sides, opts);
    const rawPts = computePoints(displaySides, angles || []);
    const {pts}  = fitPoints(rawPts, W, H, pad);

    // Shadow / depth effect
    const defs = document.createElementNS(NS, 'defs');
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', 'rebar-shadow-' + Math.random().toString(36).slice(2,6));
    const feDropShadow = document.createElementNS(NS, 'feDropShadow');
    feDropShadow.setAttribute('dx','1'); feDropShadow.setAttribute('dy','2');
    feDropShadow.setAttribute('stdDeviation','2');
    feDropShadow.setAttribute('flood-color','rgba(0,0,0,0.25)');
    filter.appendChild(feDropShadow);
    defs.appendChild(filter);
    svg.appendChild(defs);

    // Rebar body (thick stroke = steel bar)
    const pathD = 'M ' + pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ');

    // Outer glow (lighter, wider)
    const glow = document.createElementNS(NS, 'path');
    glow.setAttribute('d', pathD);
    glow.setAttribute('stroke', strokeColor);
    glow.setAttribute('stroke-opacity','0.18');
    glow.setAttribute('stroke-width', strokeW + 6);
    glow.setAttribute('fill','none');
    glow.setAttribute('stroke-linecap','round');
    glow.setAttribute('stroke-linejoin','round');
    svg.appendChild(glow);

    // Main bar - dark steel base
    const barBase = document.createElementNS(NS, 'path');
    barBase.setAttribute('d', pathD);
    barBase.setAttribute('stroke', '#7a3a08');
    barBase.setAttribute('stroke-width', strokeW + 1);
    barBase.setAttribute('fill','none');
    barBase.setAttribute('stroke-linecap','round');
    barBase.setAttribute('stroke-linejoin','round');
    svg.appendChild(barBase);

    // Main bar - accent color
    const bar = document.createElementNS(NS, 'path');
    bar.setAttribute('d', pathD);
    bar.setAttribute('stroke', strokeColor);
    bar.setAttribute('stroke-width', strokeW);
    bar.setAttribute('fill','none');
    bar.setAttribute('stroke-linecap','round');
    bar.setAttribute('stroke-linejoin','round');
    bar.setAttribute('filter', `url(#${filter.getAttribute('id')})`);
    svg.appendChild(bar);

    // Highlight (lighter stripe on top = 3D roundness effect)
    const highlight = document.createElementNS(NS, 'path');
    highlight.setAttribute('d', pathD);
    highlight.setAttribute('stroke', 'rgba(255,220,190,0.45)');
    highlight.setAttribute('stroke-width', Math.max(1, strokeW - 2));
    highlight.setAttribute('fill','none');
    highlight.setAttribute('stroke-linecap','round');
    highlight.setAttribute('stroke-linejoin','round');
    highlight.setAttribute('stroke-dashoffset','0');
    svg.appendChild(highlight);

    // Bend circles at joints
    pts.slice(1, -1).forEach(p => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', strokeW * 0.8);
      c.setAttribute('fill', strokeColor);
      c.setAttribute('stroke', '#7a3a08');
      c.setAttribute('stroke-width','0.5');
      svg.appendChild(c);
    });

    // End-cap dots
    [pts[0], pts[pts.length-1]].forEach(p => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', strokeW * 0.6);
      c.setAttribute('fill', '#7a3a08');
      svg.appendChild(c);
    });

    // Dimension and bend labels (if requested)
    if (opts.showDimensions && sides.length <= 6) {
      const rawPts2 = computePoints(displaySides, angles || []);
      const {pts: scaledForLabel} = fitPoints(rawPts2, W, H, Math.max(pad, 30));
      const centerX = scaledForLabel.reduce((sum, p) => sum + p.x, 0) / scaledForLabel.length;
      const centerY = scaledForLabel.reduce((sum, p) => sum + p.y, 0) / scaledForLabel.length;
      const segs = [];

      sides.forEach((len, i) => {
        const p1 = scaledForLabel[i], p2 = scaledForLabel[i + 1];
        if (!p1 || !p2) return;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const segLen = Math.hypot(dx, dy) || 1;
        const ux = dx / segLen;
        const uy = dy / segLen;
        let nx = -uy;
        let ny = ux;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        if ((mx + nx * 18 - centerX) ** 2 + (my + ny * 18 - centerY) ** 2 <
            (mx - nx * 18 - centerX) ** 2 + (my - ny * 18 - centerY) ** 2) {
          nx = -nx;
          ny = -ny;
        }
        let labelAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (labelAngle > 90) labelAngle -= 180;
        if (labelAngle < -90) labelAngle += 180;
        const value = formatLengthCmFromMm(len);
        const tagW = dimensionTagWidth(value);
        const lx = mx + nx * 22;
        const ly = my + ny * 22;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('transform', `translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(${labelAngle.toFixed(1)})`);
        g.setAttribute('data-shape-dim-label', String(i));

        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', (-tagW / 2).toFixed(1));
        rect.setAttribute('y', '-8');
        rect.setAttribute('width', String(tagW));
        rect.setAttribute('height', '16');
        rect.setAttribute('rx', '3');
        rect.setAttribute('fill', '#ffffff');
        rect.setAttribute('stroke', '#94a3b8');
        rect.setAttribute('stroke-width', '0.8');
        g.appendChild(rect);

        const valueText = document.createElementNS(NS, 'text');
        valueText.setAttribute('x', '0');
        valueText.setAttribute('y', '4');
        valueText.setAttribute('text-anchor', 'middle');
        valueText.setAttribute('font-size', '10');
        valueText.setAttribute('font-family', 'Heebo, Arial, sans-serif');
        valueText.setAttribute('font-weight', '900');
        valueText.setAttribute('fill', '#0b3554');
        valueText.textContent = value;
        g.appendChild(valueText);
        svg.appendChild(g);
        segs.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ux, uy });
      });

      for (let i = 0; i < segs.length - 1; i++) {
        const angle = Number((angles || [])[i]);
        if (!Number.isFinite(angle) || Math.abs(angle - 180) < 0.001) continue;
        const s1 = segs[i], s2 = segs[i + 1];
        const bx = s1.x2;
        const by = s1.y2;
        const u1x = -s1.ux, u1y = -s1.uy;
        const u2x = s2.ux, u2y = s2.uy;
        if (Math.abs(Math.abs(angle) - 90) < 0.001) {
          const m = 8;
          const p1x = bx + u1x * m, p1y = by + u1y * m;
          const p2x = p1x + u2x * m, p2y = p1y + u2y * m;
          const p3x = bx + u2x * m, p3y = by + u2y * m;
          const mark = document.createElementNS(NS, 'path');
          mark.setAttribute('d', `M ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)} L ${p3x.toFixed(1)} ${p3y.toFixed(1)}`);
          mark.setAttribute('fill', 'none');
          mark.setAttribute('stroke', '#c4c8cf');
          mark.setAttribute('stroke-width', '2');
          mark.setAttribute('data-shape-right-angle', String(i));
          svg.appendChild(mark);
        } else {
          const r = 13;
          const ax1 = bx + u1x * r, ay1 = by + u1y * r;
          const ax2 = bx + u2x * r, ay2 = by + u2y * r;
          let bxOut = u1x + u2x;
          let byOut = u1y + u2y;
          const bLen = Math.hypot(bxOut, byOut) || 1;
          bxOut /= bLen;
          byOut /= bLen;
          const tx = bx + bxOut * 20;
          const ty = by + byOut * 20;
          const g = document.createElementNS(NS, 'g');
          g.setAttribute('data-shape-angle-label', String(i));
          const arc = document.createElementNS(NS, 'path');
          arc.setAttribute('d', `M ${ax1.toFixed(1)} ${ay1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${Math.abs(angle) > 180 ? 1 : 0} ${angle >= 0 ? 1 : 0} ${ax2.toFixed(1)} ${ay2.toFixed(1)}`);
          arc.setAttribute('fill', 'none');
          arc.setAttribute('stroke', '#c9621a');
          arc.setAttribute('stroke-width', '1.6');
          arc.setAttribute('stroke-linecap', 'round');
          arc.setAttribute('data-shape-angle-arc', String(i));
          g.appendChild(arc);
          const text = document.createElementNS(NS, 'text');
          text.setAttribute('x', tx.toFixed(1));
          text.setAttribute('y', ty.toFixed(1));
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dominant-baseline', 'middle');
          text.setAttribute('font-size', '9');
          text.setAttribute('font-family', 'Heebo, Arial, sans-serif');
          text.setAttribute('font-weight', '900');
          text.setAttribute('fill', '#c9621a');
          text.textContent = String(Math.round(angle)) + '\u00B0';
          g.appendChild(text);
          svg.appendChild(g);
        }
      }
    }

    container.appendChild(svg);
  }

  /* ── Isometric 3D renderer ────────────────────────────────── */
  function renderShape3D(container, sides, angles, opts) {
    if (!container) return;
    opts = opts || {};
    const W   = opts.width  || 220;
    const H   = opts.height || 160;
    const pad = opts.padding || 28;

    const BAR_R = opts.barRadius || 5; // visual bar half-thickness
    const strokeColor  = opts.color || '#c9621a';
    const strokeDark   = '#7a3a08';
    const strokeLight  = '#e8a070';

    container.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width',  W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.display = 'block';

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', W); bg.setAttribute('height', H);
    bg.setAttribute('fill', opts.bgColor || '#f0f4f8'); bg.setAttribute('rx', 6);
    svg.appendChild(bg);

    if (!sides || sides.length === 0) {
      container.appendChild(svg);
      return;
    }

    // Compute 2D path first
    const rawPts = computePoints(sides, angles || []);
    const {pts, scale} = fitPoints(rawPts, W * 0.75, H * 0.75, pad);

    // Isometric projection: rotate 30° and apply Y-skew
    // iso(x,y) → screen(x + y*cos30, centerY - y*sin30)
    const ISO_ANGLE = 30 * Math.PI / 180;
    const DEPTH = BAR_R * 1.5; // extrusion depth for 3D effect

    function iso(x, y) {
      // Apply slight isometric tilt for 3D feel
      return {
        sx: x + y * Math.cos(ISO_ANGLE) * 0.3,
        sy: y * (1 - Math.sin(ISO_ANGLE) * 0.2)
      };
    }

    // Draw each segment as a 3D extruded bar
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i+1];
      const {sx:sx1,sy:sy1} = iso(p1.x, p1.y);
      const {sx:sx2,sy:sy2} = iso(p2.x, p2.y);

      // Direction vector perpendicular to segment for bar width
      const dx = sx2 - sx1, dy = sy2 - sy1;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const nx = -dy/len * BAR_R, ny = dx/len * BAR_R; // normal

      // Top face (lighter)
      const top = document.createElementNS(NS, 'polygon');
      top.setAttribute('points', [
        `${(sx1+nx).toFixed(1)},${(sy1+ny-DEPTH).toFixed(1)}`,
        `${(sx2+nx).toFixed(1)},${(sy2+ny-DEPTH).toFixed(1)}`,
        `${(sx2-nx).toFixed(1)},${(sy2-ny-DEPTH).toFixed(1)}`,
        `${(sx1-nx).toFixed(1)},${(sy1-ny-DEPTH).toFixed(1)}`
      ].join(' '));
      top.setAttribute('fill', strokeLight);
      top.setAttribute('stroke', strokeDark);
      top.setAttribute('stroke-width','0.5');
      svg.appendChild(top);

      // Front face (main color)
      const front = document.createElementNS(NS, 'polygon');
      front.setAttribute('points', [
        `${(sx1-nx).toFixed(1)},${(sy1-ny-DEPTH).toFixed(1)}`,
        `${(sx2-nx).toFixed(1)},${(sy2-ny-DEPTH).toFixed(1)}`,
        `${(sx2-nx).toFixed(1)},${(sy2-ny).toFixed(1)}`,
        `${(sx1-nx).toFixed(1)},${(sy1-ny).toFixed(1)}`
      ].join(' '));
      front.setAttribute('fill', strokeColor);
      front.setAttribute('stroke', strokeDark);
      front.setAttribute('stroke-width','0.5');
      svg.appendChild(front);

      // Side face (darker)
      const side = document.createElementNS(NS, 'polygon');
      side.setAttribute('points', [
        `${(sx1+nx).toFixed(1)},${(sy1+ny-DEPTH).toFixed(1)}`,
        `${(sx1+nx).toFixed(1)},${(sy1+ny).toFixed(1)}`,
        `${(sx1-nx).toFixed(1)},${(sy1-ny).toFixed(1)}`,
        `${(sx1-nx).toFixed(1)},${(sy1-ny-DEPTH).toFixed(1)}`
      ].join(' '));
      side.setAttribute('fill', strokeDark);
      side.setAttribute('stroke', strokeDark);
      side.setAttribute('stroke-width','0.5');
      svg.appendChild(side);
    }

    // Outline stroke on top for crispness
    const pathD = 'M ' + pts.map(p => {
      const {sx,sy} = iso(p.x, p.y);
      return `${sx.toFixed(1)},${(sy-DEPTH).toFixed(1)}`;
    }).join(' L ');
    const outline = document.createElementNS(NS, 'path');
    outline.setAttribute('d', pathD);
    outline.setAttribute('stroke', strokeDark);
    outline.setAttribute('stroke-width','1.5');
    outline.setAttribute('fill','none');
    outline.setAttribute('stroke-linecap','round');
    outline.setAttribute('stroke-linejoin','round');
    svg.appendChild(outline);

    container.appendChild(svg);
  }

  /* ── Convenience: render into element by ID ──────────────── */
  function renderShapeById(elId, shape, mode, opts) {
    const el = document.getElementById(elId);
    if (!el || !shape) return;
    const sides  = typeof shape.sides_default  === 'string' ? JSON.parse(shape.sides_default)  : (shape.sides_default  || []);
    const angles = typeof shape.angles_default === 'string' ? JSON.parse(shape.angles_default) : (shape.angles_default || []);
    if (mode === '3d') renderShape3D(el, sides, angles, opts);
    else               renderShape2D(el, sides, angles, opts);
  }

  /* ── Inline shape card HTML ──────────────────────────────── */
  function shapeCardHTML(shape, size) {
    size = size || 100;
    const id = 'shp-' + (shape.id||Math.random().toString(36).slice(2));
    // Returns HTML string; call initShapeCards() after inserting into DOM
    return `<div class="shape-card-preview" data-shape-id="${shape.id}"
      data-sides="${encodeURIComponent(JSON.stringify(shape.sides_default||[]))}"
      data-angles="${encodeURIComponent(JSON.stringify(shape.angles_default||[]))}"
      style="width:${size}px;height:${Math.round(size*0.7)}px;display:inline-block;cursor:pointer"
      id="${id}">
    </div>`;
  }

  function initShapeCards(opts) {
    document.querySelectorAll('.shape-card-preview').forEach(el => {
      try {
        const sides  = JSON.parse(decodeURIComponent(el.dataset.sides  || '%5B%5D'));
        const angles = JSON.parse(decodeURIComponent(el.dataset.angles || '%5B%5D'));
        const w = el.offsetWidth  || 100;
        const h = el.offsetHeight || 70;
        renderShape2D(el, sides, angles, Object.assign({width:w, height:h}, opts||{}));
      } catch(e) { console.warn('shape render error', e); }
    });
  }

  /* ── Export ─────────────────────────────────────────────── */
  global.IronBendShapes = {
    render2D:       renderShape2D,
    render3D:       renderShape3D,
    renderById:     renderShapeById,
    cardHTML:       shapeCardHTML,
    initCards:      initShapeCards,
    computePoints:  computePoints,
  };

})(window);
