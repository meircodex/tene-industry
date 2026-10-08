const { isTechnicalRecognitionNote } = require('./intakeWorkflow');

const REVIEW_NOTE_LABEL = '\u05d3\u05d5\u05e8\u05e9 \u05d0\u05d9\u05de\u05d5\u05ea \u05de\u05d5\u05dc \u05de\u05e7\u05d5\u05e8 \u05d4\u05e7\u05dc\u05d9\u05d8\u05d4';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function printableItemNote(note) {
  const normalized = String(note || '').trim();
  if (!normalized) return '';
  // Editor provenance is an internal marker, not an instruction for the
  // production card.
  if (/^נוסף ידנית בעורך הצורות\.?$/u.test(normalized)) return '';
  return isTechnicalRecognitionNote(normalized) ? REVIEW_NOTE_LABEL : normalized;
}

function itemStructElement(item = {}) {
  return String(item.struct_element || item.structElement || item.element_name || item.elementName || item.element || '').trim();
}

function numericLineValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function explicitOrderLineNo(item = {}) {
  return numericLineValue(item.orderLineNo ?? item.order_line_no ?? item.line_no ?? item.lineNo ?? item.position);
}

function attachOrderLineNumbers(items = []) {
  if (!Array.isArray(items)) return [];
  const groups = new Map();
  for (const item of items) {
    const key = String(item.order_id || item.orderId || '__single_order');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const groupItems of groups.values()) {
    const total = groupItems.length;
    const ordered = [...groupItems].sort((a, b) => {
      const aExplicit = explicitOrderLineNo(a);
      const bExplicit = explicitOrderLineNo(b);
      if (aExplicit !== null || bExplicit !== null) return (aExplicit ?? Number.MAX_SAFE_INTEGER) - (bExplicit ?? Number.MAX_SAFE_INTEGER);
      const aCreated = Date.parse(a.created_at || a.createdAt || '') || 0;
      const bCreated = Date.parse(b.created_at || b.createdAt || '') || 0;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return Number(a.id || 0) - Number(b.id || 0);
    });
    ordered.forEach((item, index) => {
      item.orderLineNo = explicitOrderLineNo(item) || index + 1;
      item.orderTotalLines = total;
    });
  }
  return items;
}

function itemOrderLineLabel(item = {}) {
  const lineNo = numericLineValue(item.orderLineNo ?? item.order_line_no ?? item.line_no ?? item.lineNo ?? item.position);
  const total = numericLineValue(item.orderTotalLines ?? item.order_total_lines ?? item.totalLines);
  if (lineNo && total) return `פריט ${lineNo}/${total}`;
  if (lineNo) return `פריט ${lineNo}`;
  return 'פריט';
}

function isRoundPileCageItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  return snapshot?.family === 'piles' && snapshot?.shapeType === 'round_pile_cage';
}

function exactPileMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  return numeric.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function exactPileCentimeters(valueMm) {
  const numeric = Number(valueMm);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  return exactPileMetric(numeric / 10);
}

function pileAssemblyComponentLabel(component = {}) {
  const labels = {
    longitudinal_straight_bar: 'STRAIGHT',
    longitudinal_l_bar: 'L-BAR',
    spiral_consolidated: 'SPIRAL',
    hoop_ring: 'RINGS',
  };
  const label = labels[component.componentType];
  const quantity = Number(component.quantity);
  const diameter = Number(component.diameterMm);
  const totalLengthMm = Number(component.totalLengthMm);
  if (!label || !(quantity > 0) || !(diameter > 0) || !(totalLengthMm > 0)) return '';
  return `${label} ${exactPileMetric(quantity)} × Ø${exactPileMetric(diameter)} מ״מ · ${exactPileCentimeters(totalLengthMm)} ס״מ`;
}

function pileCageProductionSvg(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const n = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const pileDiameter = n(data.pileDiameterMm ?? data.pileDiameter ?? data.general?.pileDiameterMm);
  const pileLength = n(data.pileLengthMm ?? data.pileLength ?? data.general?.pileLengthMm);
  const bars = Math.max(0, Math.round(n(data.longitudinalBars?.totalBars ?? data.longitudinalBars?.count ?? data.longitudinalBarCount ?? data.longitudinalBars)));
  const barDiameter = n(data.longitudinalBars?.defaultDiameterMm ?? data.longitudinalBars?.diameterMm ?? data.longitudinalDiameterMm ?? data.longitudinalDiameter ?? item.diameter);
  const barRows = Array.isArray(data.longitudinalBars?.bars) ? data.longitudinalBars.bars : (Array.isArray(data.bars) ? data.bars : []);
  const firstBent = barRows.find(bar => ['l', 'bent'].includes(String(bar?.type || '').toLowerCase())) || {};
  const rawOrientation = Number(data.longitudinalBars?.defaultBendOrientationDeg ?? data.bendOrientationDeg ?? firstBent.bendOrientationDeg);
  const bendOrientationDeg = Number.isFinite(rawOrientation) ? ((rawOrientation % 360) + 360) % 360 : null;
  const bendOrientationRad = Number.isFinite(bendOrientationDeg) ? bendOrientationDeg * Math.PI / 180 : 0;
  const spiralDiameter = n(data.spiral?.barDiameterMm ?? data.spiralDiameterMm ?? data.spiralDiameter);
  const schedule = Array.isArray(data.spiral?.schedule) ? data.spiral.schedule
    : (Array.isArray(data.spiral?.zones) ? data.spiral.zones : (Array.isArray(data.spiralZones) ? data.spiralZones : []));
  const wrappedSchedule = schedule.filter(zone => !zone.noWrap);
  const pitch = n(wrappedSchedule[0]?.pitchMm ?? data.spiral?.pitchMm ?? data.spiralPitchMm ?? data.spiralPitch);
  const hoops = Math.max(0, Math.round(n(data.hoops?.quantity ?? data.hoopQuantity)));
  const hoopDiameter = n(data.hoops?.hoopBarDiameterMm ?? data.hoops?.barDiameterMm ?? data.hoops?.diameterMm ?? data.hoopDiameterMm ?? data.hoopDiameter);
  const dotCount = bars > 0 && barDiameter > 0 ? Math.min(bars, 14) : 0;
  const dots = Array.from({ length: dotCount }, (_, index) => {
    const a = -Math.PI / 2 + Math.PI * 2 * index / dotCount;
    const x = 190 + Math.cos(a) * 15;
    const y = 40 + Math.sin(a) * 15;
    const isBent = ['l', 'bent'].includes(String(barRows[index]?.type || '').toLowerCase());
    const hookAngle = a + Math.PI + bendOrientationRad;
    const hook = isBent ? `<line data-pile-bend-orientation="${bendOrientationDeg}" x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(x + Math.cos(hookAngle) * 7).toFixed(2)}" y2="${(y + Math.sin(hookAngle) * 7).toFixed(2)}" stroke="#102a43" stroke-width="2" stroke-linecap="round"/>` : '';
    return `${hook}<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2" fill="#102a43"/>`;
  }).join('');
  const totalAxisMm = schedule.reduce((sum, zone) => sum + n(zone.axialLengthMm ?? zone.lengthMm ?? zone.length), 0) || pileLength;
  let scheduleCursorMm = 0;
  const helix = spiralDiameter > 0 && (wrappedSchedule.length || pitch > 0) ? (schedule.length ? schedule.map(zone => {
    const lengthMm = n(zone.axialLengthMm ?? zone.lengthMm ?? zone.length);
    const explicitStartMm = Number(zone.startMm);
    const startMm = Number.isFinite(explicitStartMm) && explicitStartMm >= 0 ? explicitStartMm : scheduleCursorMm;
    scheduleCursorMm = startMm + lengthMm;
    if (zone.noWrap) return `<g data-no-wrap="1" data-start-mm="${startMm}" data-end-mm="${startMm + lengthMm}"></g>`;
    const startX = 14 + 146 * startMm / Math.max(1, totalAxisMm);
    const endX = startX + 146 * lengthMm / Math.max(1, totalAxisMm);
    const turns = Math.max(2, Math.min(14, Math.round(n(zone.turns) || lengthMm / Math.max(1, n(zone.pitchMm ?? zone.pitch)))));
    return Array.from({ length: turns }, (_, index) => { const x = startX + (index + 0.5) * Math.max(1, endX - startX) / turns; return `<path d="M${(x - 4).toFixed(1)} 23L${(x + 4).toFixed(1)} 55" stroke="#102a43" stroke-width="1.3"/>`; }).join('');
  }).join('') : Array.from({ length: 12 }, (_, index) => `<path d="M${14 + index * 12} 23L${26 + index * 12} 55" stroke="#102a43" stroke-width="1.3"/>`).join('')) : '';
  const rods = bars > 0 && barDiameter > 0 ? Array.from({ length: 5 }, (_, index) => `<path d="M14 ${27 + index * 7}H160" stroke="#102a43" stroke-width="1.2"/>`).join('') : '';
  const lengthCm = pileLength ? exactPileCentimeters(pileLength) : '—';
  const diameterCm = pileDiameter ? (pileDiameter / 10).toFixed(1).replace(/\.0$/, '') : '—';
  const barLabel = bars > 0 && barDiameter > 0 ? `${bars} × Ø${barDiameter}` : '—';
  const pitches = [...new Set(wrappedSchedule.map(zone => n(zone.pitchMm ?? zone.pitch)).filter(Boolean))];
  const spiralLabel = spiralDiameter > 0 && (pitches.length || pitch > 0) ? `Ø${spiralDiameter} @ ${(pitches.length ? pitches : [pitch]).map(value => value / 10).join('/')}cm` : '—';
  const hoopLabel = hoops > 0 && hoopDiameter > 0 ? `${hoops} × Ø${hoopDiameter}` : '—';
  const isAssemblyCard = item.pile_card_type === 'pile_assembly';
  const sourceSummary = Array.isArray(item.pile_component_summary)
    ? item.pile_component_summary
    : (Array.isArray(snapshot.calculated?.manufacturingBreakdown) ? snapshot.calculated.manufacturingBreakdown : []);
  const summaryByType = new Map(sourceSummary.map(component => [component.componentType, component]));
  const requiredTypes = ['longitudinal_straight_bar', 'longitudinal_l_bar', 'spiral_consolidated', 'hoop_ring'];
  const componentLines = requiredTypes.map(type => pileAssemblyComponentLabel(summaryByType.get(type))).filter(Boolean);
  const totalSteelLengthMm = Number(item.pile_total_steel_length_mm ?? snapshot.calculated?.totalSteelLengthMm ?? snapshot.calculated?.totalLengthMm);
  const hasAssemblySummary = isAssemblyCard && componentLines.length === 4 && totalSteelLengthMm > 0;
  const compactFooter = `<text x="88" y="70" text-anchor="middle" font-size="7" font-weight="800" fill="#102a43">${escapeHtml(barLabel)} · ${escapeHtml(spiralLabel)} · ${escapeHtml(hoopLabel)}</text>`;
  const assemblyRows = hasAssemblySummary
    ? `<g data-assembly-component-summary="4">${componentLines.map((line, index) => `<text x="12" y="${82 + index * 10}" text-anchor="start" font-size="7" font-weight="800" fill="#102a43">${escapeHtml(line)}</text>`).join('')}<text data-assembly-total-steel="${escapeHtml(exactPileMetric(totalSteelLengthMm))}" x="213" y="122" text-anchor="end" font-size="8" font-weight="900" fill="#102a43">STEEL ${escapeHtml(exactPileCentimeters(totalSteelLengthMm))} cm</text></g>`
    : '';
  const viewHeight = hasAssemblySummary ? 128 : 72;
  return `<svg viewBox="0 0 225 ${viewHeight}" role="img" aria-label="PILE CAGE" data-bend-orientation-reference="radial_inward"><rect x="12" y="21" width="152" height="38" rx="7" fill="#fff" stroke="#102a43" stroke-width="1.5"/>${rods}${helix}<circle cx="190" cy="40" r="20" fill="#fff" stroke="#102a43" stroke-width="1.5"/>${dots}<text x="88" y="13" text-anchor="middle" font-size="9" font-weight="900" fill="#102a43">PILE CAGE · L ${escapeHtml(lengthCm)} cm</text><text x="190" y="69" text-anchor="middle" font-size="9" font-weight="900" fill="#102a43">Ø${escapeHtml(diameterCm)} cm${Number.isFinite(bendOrientationDeg) ? ` · ↻${escapeHtml(exactPileMetric(bendOrientationDeg))}°` : ''}</text>${hasAssemblySummary ? assemblyRows : compactFooter}</svg>`;
}

function itemHumanTitle(item = {}) {
  if (isRoundPileCageItem(item)) return 'PILE CAGE';
  const element = itemStructElement(item);
  const lineLabel = itemOrderLineLabel(item);
  return element ? `${lineLabel} — ${element}` : lineLabel;
}

function parseSegments(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRightAngle(value) {
  return Math.abs(Number(value) - 90) < 0.001;
}

function normalizeAngleValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bend direction is encoded on a full 0-360 turn: -30 and 330 are the same
// physical bend, so displayed values are normalized into [0,360).
function displayBendAngleDeg(value) {
  const n = normalizeAngleValue(value);
  if (n === null) return null;
  return ((n % 360) + 360) % 360;
}

function isPrintableBendAngle(angle) {
  const n = displayBendAngleDeg(angle);
  if (n === null) return false;
  if (Math.abs(n) < 0.001) return false;
  if (Math.abs(n - 180) < 0.001) return false;
  return true;
}

function angleText(angle) {
  const n = displayBendAngleDeg(angle);
  if (n === null) return '';
  return (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '')) + '°';
}

function isOpenUShape(segments) {
  if (!Array.isArray(segments) || segments.length !== 3) return false;
  const lengths = segments.map(segment => Number(segment.length_mm || 0));
  if (lengths.some(length => length <= 0)) return false;

  const [leftLeg, bridge, rightLeg] = lengths;
  const legsSimilar = Math.abs(leftLeg - rightLeg) <= Math.max(10, Math.max(leftLeg, rightLeg) * 0.1);
  const legsShorterThanBridge = leftLeg < bridge && rightLeg < bridge;

  return isRightAngle(segments[0].angle_deg)
    && isRightAngle(segments[1].angle_deg)
    && legsShorterThanBridge
    && legsSimilar;
}

function isSimilarDimension(a, b, tolerance = 0.12) {
  const max = Math.max(Number(a) || 0, Number(b) || 0);
  if (max <= 0) return false;
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= Math.max(10, max * tolerance);
}

function proportionalPrintSides(sides) {
  const clean = (Array.isArray(sides) ? sides : []).map(value => Math.max(0, Number(value || 0)));
  const max = Math.max(0, ...clean);
  if (!max) return clean;
  return clean.map(length => {
    if (!length) return 0;
    const ratio = max / length;
    if (ratio < 6) return length;
    return Math.min(max, Math.max(length, max * 0.14));
  });
}


// כשצלע מאוחרת רצה בדיוק על גבי צלע קודמת (מוט מקופל אחורה על עצמו),
// הן מצוירות קו-על-קו ואי אפשר להבחין ביניהן בשרטוט.
function overlappingCoverIndex(points, scale) {
  let EPS = Math.max(1e-9, scale * 0.002);
  for (let i = 1; i < points.length - 1; i++) {
    let a = points[i], b = points[i + 1];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    let len = Math.sqrt(dx * dx + dy * dy);
    if (!len) continue;
    dx /= len; dy /= len;
    for (let j = 0; j < i; j++) {
      let c = points[j], d = points[j + 1];
      let ex = d[0] - c[0], ey = d[1] - c[1];
      let elen = Math.sqrt(ex * ex + ey * ey);
      if (!elen) continue;
      ex /= elen; ey /= elen;
      if (Math.abs(dx * ey - dy * ex) > 0.02) continue;
      if (Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) > EPS) continue;
      let t0 = (c[0] - a[0]) * dx + (c[1] - a[1]) * dy;
      let t1 = (d[0] - a[0]) * dx + (d[1] - a[1]) * dy;
      if (Math.max(t0, t1) <= EPS || Math.min(t0, t1) >= len - EPS) continue;
      return { covering: i, victim: j };
    }
  }
  return null;
}

// חישוקים וכל צורה סגורה שחוזרת לנקודת ההתחלה - לא בתחום הכלל הזה.
function isClosedHoopOutline(points, scale) {
  if (!points || points.length < 4 || !scale) return false;
  let first = points[0], last = points[points.length - 1];
  return Math.sqrt(Math.pow(last[0] - first[0], 2) + Math.pow(last[1] - first[1], 2)) < scale * 0.35;
}

// קיצור ויזואלי בלבד של הצלע הצמודה לצלע הקצרה שנדרסת, כדי שהשתיים ייפרדו.
// המידות המודפסות נשענות על sides המקורי ולא מושפעות.
const OVERLAP_SEPARATION_RATIO = 0.10;
function separateOverlappingSides(visualSides, angles) {
  if (!visualSides || visualSides.length < 3) return visualSides;
  let max = Math.max.apply(null, visualSides.concat([0]));
  let shapePoints = calcShapePoints(visualSides, angles || []);
  if (isClosedHoopOutline(shapePoints, max)) return visualSides;
  let hit = overlappingCoverIndex(shapePoints, max);
  if (!hit) return visualSides;
  let legIndex = hit.victim > 0 ? hit.victim - 1 : hit.victim + 1;
  if (legIndex < 0 || legIndex >= visualSides.length) return visualSides;
  let adjusted = visualSides.slice();
  let leg = adjusted[legIndex];
  adjusted[legIndex] = Math.max(leg * 0.5, leg - max * OVERLAP_SEPARATION_RATIO);
  return adjusted;
}

function calcShapePoints(sides, angles) {
  const points = [[0, 0]];
  let direction = 0;
  for (let i = 0; i < sides.length; i += 1) {
    const previous = points[points.length - 1];
    const radians = direction * Math.PI / 180;
    points.push([
      previous[0] + sides[i] * Math.cos(radians),
      previous[1] + sides[i] * Math.sin(radians),
    ]);
    if (i < angles.length) {
      direction -= (180 - Number(angles[i] ?? 180));
    }
  }
  return points;
}

function normalizeShapePointsBaseBottom(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return points;
  let longest = { index: 0, length: 0, angle: 0 };
  for (let i = 0; i < points.length - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const length = Math.hypot(dx, dy);
    if (length > longest.length) longest = { index: i, length, angle: Math.atan2(dy, dx) };
  }
  if (!longest.length) return points;

  const cos = Math.cos(-longest.angle);
  const sin = Math.sin(-longest.angle);
  let rotated = points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  const base = rotated[longest.index];
  const baseNext = rotated[longest.index + 1];
  const baseY = (base[1] + baseNext[1]) / 2;
  const bodyY = rotated.reduce((sum, point) => sum + point[1], 0) / rotated.length;
  if (bodyY > baseY) rotated = rotated.map(([x, y]) => [x, baseY + (baseY - y)]);
  const rotateDegrees = Number(opts.rotateDegrees || 0);
  if (rotateDegrees) {
    const xs = rotated.map(point => point[0]);
    const ys = rotated.map(point => point[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radians = rotateDegrees * Math.PI / 180;
    const rotateCos = Math.cos(radians);
    const rotateSin = Math.sin(radians);
    rotated = rotated.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      return [cx + dx * rotateCos - dy * rotateSin, cy + dx * rotateSin + dy * rotateCos];
    });
  }
  return rotated;
}

function closedStirrupParts(segments) {
  if (!Array.isArray(segments) || segments.length < 4) return null;
  const lengths = segments.map(segment => Number(segment.length_mm || 0));
  if (lengths.some(length => length <= 0)) return null;
  const rightAngles = segments.slice(0, Math.min(4, segments.length - 1))
    .filter(segment => segment.angle_deg != null)
    .every(segment => isRightAngle(segment.angle_deg));
  if (!rightAngles) return null;

  if (segments.length >= 5) {
    // Imported hoop rows use: side, closure excess, side, closure excess,
    // side, side. The two inner segments are the closure excesses; the first
    // and last segments are the matching body side (e.g. 25/10/50/10/50/25).
    const [sideA, tailStart, horizontalA, tailEnd, horizontalB, sideB] = lengths;
    const maxBody = Math.max(sideA, horizontalA, horizontalB, sideB || sideA);
    const hasSmallTails = tailStart <= maxBody * 0.6 && (!tailEnd || tailEnd <= maxBody * 0.6);
    if (
      hasSmallTails &&
      isSimilarDimension(sideA, sideB || sideA) &&
      isSimilarDimension(horizontalA, horizontalB)
    ) {
      return {
        top: horizontalA,
        right: sideA,
        bottom: horizontalB,
        left: sideB || sideA,
        tailStart,
        tailEnd,
      };
    }
  }

  const [top, right, bottom, left] = lengths;
  if (isSimilarDimension(top, bottom) && isSimilarDimension(right, left)) {
    return { top, right, bottom, left, tailStart: lengths[4] || 0, tailEnd: 0 };
  }

  return null;
}


function displayLengthCm(value) {
  const cm = (Number(value) || 0) / 10;
  if (!Number.isFinite(cm)) return '';
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1).replace(/\.0$/, '');
}

function pointAt(point, vector, distance) {
  return [point[0] + vector[0] * distance, point[1] + vector[1] * distance];
}

function unitVector(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [dx / len, dy / len];
}

function angleLabelSvg(text, x, y, color = '#c9621a') {
  return '<text data-angle-label="1" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="11" font-family="Heebo,Arial" font-weight="900" fill="' + color + '" stroke="white" stroke-width="3.4" paint-order="stroke fill" stroke-linejoin="round">' + escapeHtml(text) + '</text>';
}

function angleLabelPosition(previous, corner, next, distance = 22) {
  // Place the label along the external bisector of the corner so it never
  // lands on either arm segment or on the side-dimension labels
  // (centroid-based placement collapses on Z/zigzag shapes).
  const a = unitVector(corner, previous);
  const b = unitVector(corner, next);
  let vx = a[0] + b[0];
  let vy = a[1] + b[1];
  let len = Math.sqrt(vx * vx + vy * vy);
  if (len < 0.001) {
    vx = -a[1];
    vy = a[0];
    len = 1;
  }
  vx /= len;
  vy /= len;
  return [corner[0] - vx * distance, corner[1] - vy * distance];
}

// Drawing rule: a right angle is marked by the corner square only — no "90°"
// text next to it. Angle text is printed only for non-90° bends.
function rightAngleMarkerSvg(previous, corner, next) {
  const a = unitVector(corner, previous);
  const b = unitVector(corner, next);
  const d = 9;
  const p1 = pointAt(corner, a, d);
  const p2 = [p1[0] + b[0] * d, p1[1] + b[1] * d];
  const p3 = pointAt(corner, b, d);
  return '<path d="M ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' L ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + ' L ' + p3[0].toFixed(1) + ',' + p3[1].toFixed(1) + '" fill="none" stroke="#a8b0ba" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter"/>';
}

function dimensionLabelSvg(text, x, y, width = 38) {
  return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.8" paint-order="stroke fill" stroke-linejoin="round">' + escapeHtml(text) + '</text>';
}

function sideDimensionSvg(start, end, value, center, distance = 18) {
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if ((mid[0] + nx * distance - center[0]) * nx + (mid[1] + ny * distance - center[1]) * ny < 0) {
    nx *= -1;
    ny *= -1;
  }
  const label = [mid[0] + nx * distance, mid[1] + ny * distance];
  const text = displayLengthCm(value);
  const width = Math.max(30, Math.min(48, text.length * 7 + 14));
  return '<line x1="' + mid[0].toFixed(1) + '" y1="' + mid[1].toFixed(1) + '" x2="' + label[0].toFixed(1) + '" y2="' + label[1].toFixed(1) + '" stroke="#aeb8c5" stroke-width="0.8"/>' +
    dimensionLabelSvg(text, label[0], label[1], width);
}

function angleMarkerSvg(previous, corner, next, angle, center) {
  if (!isPrintableBendAngle(angle)) return '';
  // 90° היא ברירת המחדל של כיפוף במוט - לא מסמנים אותה בשרטוט.
  // בחישוקים הסימון נשמר - שם יש חוק אחר.
  if (isRightAngle(angle)) return '';
  const a = unitVector(corner, previous);
  const b = unitVector(corner, next);
  const p1 = pointAt(corner, a, 13);
  const p2 = pointAt(corner, b, 13);
  const label = angleLabelPosition(previous, corner, next, 22);
  return '<path d="M ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' Q ' + corner[0].toFixed(1) + ',' + corner[1].toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + '" fill="none" stroke="#c9621a" stroke-width="1.4" stroke-linecap="round"/>' +
    angleLabelSvg(angleText(angle), label[0], label[1]);
}

function straightShapeSvg(segment) {
  const length = Number(segment && segment.length_mm || 0);
  const width = 220;
  const height = 80;
  const y = 40;
  const x1 = 22;
  const x2 = 198;
  const text = displayLengthCm(length);
  let svg = '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="#1a2332" stroke-width="4" stroke-linecap="round"/>';
  svg += '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round"/>';
  svg += dimensionLabelSvg(text, width / 2, 18, Math.max(34, Math.min(54, text.length * 7 + 18)));
  svg += '<line x1="' + (width / 2).toFixed(1) + '" y1="25" x2="' + (width / 2).toFixed(1) + '" y2="' + (y - 5) + '" stroke="#aeb8c5" stroke-width="0.8"/>';
  return '<svg data-shape-kind="straight-bar" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:100%;max-height:90px;overflow:visible">' + svg + '</svg>';
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shapeSnapshotFromItem(item = {}) {
  return parseJsonObject(item.shape_snapshot_json || item.shapeSnapshot || item.shape_snapshot || item.shapeData || item.shape_data) || {};
}

function isBenchBarItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const shapeType = item.shapeType || item.shape_type || snapshot.shapeType || data.shapeType;
  const presetId = item.shapeId || item.shape_id || item.presetId || item.preset_id;
  const name = item.shape_name || item.shapeName || item.shape || snapshot.displayName || '';
  return shapeType === 'bench_bar'
    || presetId === 's15'
    || /^\s*(?:ספסל|bench)\s*$/i.test(String(name));
}

function isRoundedEndBarItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput?.generic || {};
  const shapeType = item.shapeType || item.shape_type || snapshot.shapeType || data.shapeType || generic.shapeType;
  return shapeType === 'rounded_end_bar' || data.roundedBends === true || generic.roundedBends === true;
}

function roundedEndBarRadiusMm(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput?.generic || {};
  const value = Number(item.radiusMm ?? item.radius_mm ?? data.radiusMm ?? data.radius_mm ?? generic.radiusMm ?? generic.radius_mm);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeSnapshotSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map(segment => ({
    length_mm: Number(segment.length_mm ?? segment.lengthMm ?? segment.length ?? 0),
    angle_deg: normalizeAngleValue(segment.bendAfterDeg ?? segment.bend_after_deg ?? segment.angle_deg ?? segment.angleDeg ?? segment.angle),
  })).filter(segment => Number.isFinite(segment.length_mm) && segment.length_mm > 0);
}

function snapshotSegments(snapshot = {}) {
  const generic = snapshot.machineOutput && snapshot.machineOutput.generic ? snapshot.machineOutput.generic : {};
  const data = snapshot.data || {};
  const genericSegments = normalizeSnapshotSegments(generic.segments);
  if (genericSegments.length) return genericSegments;
  const dataSegments = normalizeSnapshotSegments(data.segments);
  if (dataSegments.length) return dataSegments;
  const sides = Array.isArray(data.sides) ? data.sides : [];
  const angles = Array.isArray(data.angles) ? data.angles : [];
  return sides.map((length, index) => ({
    length_mm: Number(length) || 0,
    angle_deg: index < sides.length - 1 ? normalizeAngleValue(angles[index]) : null,
  })).filter(segment => segment.length_mm > 0);
}

function shapeSegmentsFromItem(item = {}) {
  // `items.segments` is the live geometry of the order item.  A Shape V2
  // snapshot is retained for history and for records that predate segments,
  // but it must not override a newer saved item definition.  Otherwise an
  // old snapshot can make the QR card/print show 15 cm after the item was
  // corrected to 12 cm in the order.
  const fromItem = normalizeSnapshotSegments(parseSegments(item.segments));
  if (fromItem.length) return fromItem;
  return snapshotSegments(shapeSnapshotFromItem(item));
}

function hasPrintableBends(segments) {
  return Array.isArray(segments) && segments.length > 1 && segments.slice(0, -1).some(segment => isPrintableBendAngle(segment.angle_deg));
}

function shapeSvgHasAngleLabels(svg) {
  return /data-angle-label|\u00b0|&deg;/.test(String(svg || ''));
}

function shapeSvgForProductionCard(item = {}, segments = shapeSegmentsFromItem(item)) {
  if (isRoundPileCageItem(item)) return pileCageProductionSvg(item);
  const cleanSegments = Array.isArray(segments) ? segments : [];
  const generated = itemShapeSvg({ ...item, segments: JSON.stringify(cleanSegments), shape_svg: '' });
  if (cleanSegments.length) return generated;
  return item.shape_svg ? String(item.shape_svg) : generated;
}

function shapeDiameterFromItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput && snapshot.machineOutput.generic ? snapshot.machineOutput.generic : {};
  const value = item.diameter ?? item.diameterMm ?? data.diameter ?? data.diameterMm ?? data.barDiameter ?? data.barDiameterMm ?? generic.diameter ?? generic.diameterMm;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function shapeTotalLengthMmFromItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const generic = snapshot.machineOutput && snapshot.machineOutput.generic ? snapshot.machineOutput.generic : {};
  const value = item.total_length_mm ?? item.totalLengthMm ?? snapshot.calculated?.totalLengthMm ?? generic.totalLengthMm ?? generic.lengthMm;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
function isSpiralName(value) {
  return /spiral|ring|coil|spring|helix|ספיר|ספירלה|טבעת|סליל|לולאה|קפיץ/i.test(String(value || ''));
}

function spiralParamsFromItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  const data = snapshot.data || {};
  const generic = snapshot.machineOutput && snapshot.machineOutput.generic ? snapshot.machineOutput.generic : {};
  const spiralDiameterMm = Number(
    item.spiral_diameter_mm ?? item.spiralDiameterMm ?? item.spiralDiameter ??
    snapshot.spiralDiameterMm ?? snapshot.spiral_diameter_mm ??
    data.ringDiameterMm ?? data.bendingDiameterMm ??
    data.spiral?.diameterMm ?? data.spiral?.diameter ??
    data.spiralDiameterMm ?? data.spiralDiameter ?? data.spiral_diameter_mm ??
    generic.spiralDiameterMm ?? generic.spiralDiameter ?? 0
  );
  const turns = Number(
    item.spiral_turns ?? item.spiralTurns ?? item.turns ??
    snapshot.spiralTurns ?? snapshot.spiral_turns ??
    data.spiral?.turns ??
    data.spiralTurns ?? data.turns ?? data.spiral_turns ??
    generic.spiralTurns ?? generic.turns ?? 0
  );
  const name = item.shape_name || item.shapeName || item.shape || snapshot.shapeName || snapshot.displayName || snapshot.shapeType || snapshot.shapeId;
  const family = item.family || snapshot.family || data.family || generic.family;
  const shapeType = item.shapeType || snapshot.shapeType || data.shapeType || generic.shapeType;
  const overlapMm = Number(data.overlapMm ?? data.overlap ?? generic.overlapMm ?? item.overlapMm ?? item.overlap ?? 0);
  const isSpiral = isSpiralName(name) || isSpiralName(shapeType) || family === 'spirals';
  return {
    isSpiral: isSpiral && Number.isFinite(spiralDiameterMm) && spiralDiameterMm > 0 && Number.isFinite(turns) && turns > 0,
    spiralDiameterMm,
    turns,
    shapeType,
    overlapMm: Number.isFinite(overlapMm) ? Math.max(0, overlapMm) : 0,
  };
}

function archimedeanSpiralPath(cx, cy, innerRadius, outerRadius, displayTurns = 4.25, samples = 170) {
  const points = [];
  const safeSamples = Math.max(24, Number(samples) || 170);
  for (let index = 0; index <= safeSamples; index += 1) {
    const progress = index / safeSamples;
    const theta = progress * displayTurns * Math.PI * 2;
    const radius = innerRadius + (outerRadius - innerRadius) * progress;
    points.push([
      cx + Math.cos(theta) * radius,
      cy + Math.sin(theta) * radius,
    ]);
  }
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
}

function spiralShapeSvg(item = {}) {
  const spiral = spiralParamsFromItem(item);
  if (!spiral.isSpiral) return '';
  const width = 240;
  const height = 118;
  const spiralDiameterLabel = Math.round(spiral.spiralDiameterMm);
  const spiralDiameterCmLabel = displayLengthCm(spiral.spiralDiameterMm);
  const turnsLabel = Math.round(spiral.turns);
  const isRing = spiral.shapeType === 'ring' || spiral.turns <= 1.5;

  // \u2500\u2500 RING (1 turn): draw the overlap on the ring and point the 20 cm callout at it. \u2500\u2500
  if (isRing) {
    const cx = spiral.overlapMm > 0 ? 96 : 120, cy = 54, r = 34;
    let svg = `<defs><marker id="arr-r" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#c9621a"/></marker><marker id="arr-rl" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 Z" fill="#c9621a"/></marker></defs>`;
    svg += `<text x="${cx}" y="13" text-anchor="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">\u05d8\u05d1\u05e2\u05ea</text>`;
    // circle
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1a2332" stroke-width="4"/>`;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a5070" stroke-width="1.5"/>`;
    if (spiral.overlapMm > 0) {
      const overlapX = cx + Math.sqrt((r * r) - (18 * 18));
      const overlapCm = Math.round(spiral.overlapMm / 10);
      svg += `<g data-ring-overlap-dimension="1" font-family="Heebo,Arial">`;
      svg += `<path d="M ${overlapX.toFixed(1)} ${cy - 18} A ${r} ${r} 0 0 1 ${overlapX.toFixed(1)} ${cy + 18}" fill="none" stroke="#c9621a" stroke-width="5" stroke-linecap="round"/>`;
      svg += `<path d="M ${(overlapX - 4).toFixed(1)} ${cy - 22} L ${(overlapX + 5).toFixed(1)} ${cy - 14} M ${(overlapX - 4).toFixed(1)} ${cy + 22} L ${(overlapX + 5).toFixed(1)} ${cy + 14}" fill="none" stroke="#c9621a" stroke-width="1.5"/>`;
      svg += `<path d="M ${(overlapX + 5).toFixed(1)} ${cy} H 150" fill="none" stroke="#c9621a" stroke-width="1.5"/>`;
      svg += `<rect x="150" y="38" width="82" height="32" rx="5" fill="#fff7ed" stroke="#c9621a" stroke-width="1.4"/>`;
      svg += `<text x="191" y="50" text-anchor="middle" font-size="8" font-weight="900" fill="#9a4b10">\u05d7\u05e4\u05d9\u05e4\u05d4</text>`;
      svg += `<text x="191" y="64" text-anchor="middle" font-size="12" font-weight="900" fill="#1a2332">${overlapCm} \u05e1\u05f4\u05de</text>`;
      svg += `</g>`;
    }
    // diameter dimension line
    svg += `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="#c9621a" stroke-width="1.4" marker-start="url(#arr-rl)" marker-end="url(#arr-r)"/>`;
    svg += `<text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#c9621a">\u00d8 ${spiralDiameterCmLabel} \u05e1\u05f4\u05de</text>`;
    // labels
    svg += `<g data-spiral-visual-labels="1" font-family="Heebo,Arial">`;
    svg += `<rect x="34" y="95" width="78" height="20" rx="4" fill="#fff7ed" stroke="#c9621a" stroke-width="1"/>`;
    svg += `<text x="73" y="109" text-anchor="middle" font-size="10" font-weight="900" fill="#1a2332">\u00d8 ${spiralDiameterCmLabel} \u05e1\u05f4\u05de</text>`;
    svg += `<rect x="128" y="95" width="78" height="20" rx="4" fill="#fff7ed" stroke="#c9621a" stroke-width="1"/>`;
    svg += `<text x="167" y="109" text-anchor="middle" font-size="10" font-weight="900" fill="#1a2332">${spiral.overlapMm > 0 ? `${Math.round(spiral.overlapMm / 10)} \u05e1\u05f4\u05de \u05d7\u05e4\u05d9\u05e4\u05d4` : `1 \u05db\u05e8\u05d9\u05db\u05d4`}</text>`;
    svg += `</g>`;
    return `<svg data-shape-kind="ring" data-spiral-diameter-mm="${spiralDiameterLabel}" data-spiral-turns="${turnsLabel}" data-ring-overlap-mm="${Math.round(spiral.overlapMm)}" data-scale-mode="container-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;overflow:visible">${svg}</svg>`;
  }

  // \u2500\u2500 SPIRAL (>1 turn): real multi-turn plan view; count stays above the coil. \u2500\u2500
  const cx = 120, cy = 52, r = 34;
  let svg = `<defs><marker id="arr-s" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#c9621a"/></marker><marker id="arr-sl" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 Z" fill="#c9621a"/></marker></defs>`;
  svg += `<text data-spiral-turn-count="1" x="${cx}" y="13" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">N=${turnsLabel}</text>`;
  const spiralPath = archimedeanSpiralPath(cx, cy, 3, r, 4.25, 170);
  svg += `<path d="${spiralPath}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${spiralPath}" fill="none" stroke="#3a5070" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  // diameter dimension line inside the circle
  svg += `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="#c9621a" stroke-width="1.4" marker-start="url(#arr-sl)" marker-end="url(#arr-s)"/>`;
  svg += `<text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#c9621a">\u00d8 ${spiralDiameterCmLabel} \u05e1\u05f4\u05de</text>`;
  svg += `<g data-spiral-visual-labels="1" font-family="Heebo,Arial">`;
  svg += `<rect x="34" y="88" width="78" height="26" rx="5" fill="#fff7ed" stroke="#c9621a" stroke-width="1.2"/>`;
  svg += `<text x="73" y="98" text-anchor="middle" font-size="7.5" font-weight="900" fill="#9a4b10">\u05e7\u05d5\u05d8\u05e8 \u05e1\u05e4\u05d9\u05e8\u05d0\u05dc\u05d4</text>`;
  svg += `<text x="73" y="110" text-anchor="middle" font-size="11" font-weight="900" fill="#1a2332">${spiralDiameterCmLabel} \u05e1\u05f4\u05de</text>`;
  svg += `<rect x="128" y="88" width="78" height="26" rx="5" fill="#fff7ed" stroke="#c9621a" stroke-width="1.2"/>`;
  svg += `<text x="167" y="98" text-anchor="middle" font-size="9" font-weight="900" fill="#9a4b10">N</text>`;
  svg += `<text x="167" y="110" text-anchor="middle" font-size="11" font-weight="900" fill="#1a2332">N=${turnsLabel}</text>`;
  svg += `</g>`;
  return `<svg data-shape-kind="spiral" data-spiral-diameter-mm="${spiralDiameterLabel}" data-spiral-turns="${turnsLabel}" data-scale-mode="container-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;overflow:visible">${svg}</svg>`;
}

function isLiftPackageItem(item = {}) {
  const snapshot = shapeSnapshotFromItem(item);
  return snapshot?.family === 'lifts' && snapshot?.shapeType === 'lift_package';
}

// A lift is a purchased bundle: one diameter, one bar length, weighed per package.
// It carries no bend geometry, so the card shows the bundle instead of a bar outline.
function liftPackageProductionSvg(item = {}) {
  const snapshot = shapeSnapshotFromItem(item) || {};
  const data = snapshot.data || {};
  const diameter = Number(data.diameter || item.diameter || 0);
  const barLengthMm = Number(data.barLength || item.total_length_mm || 0);
  const packages = Number(item.quantity || 0);
  const weighed = Number(data.weighedKg || item.weight_per_unit || 0);
  const W = 220, H = 100;
  const x = 26, y = 26, bw = W - 52, bh = 40;
  let svg = '';
  svg += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '" rx="3" fill="none" stroke="#1a2332" stroke-width="2.2"/>';
  for (let i = 1; i <= 3; i += 1) {
    const by = y + (bh / 4) * i;
    svg += '<line x1="' + (x + 8) + '" y1="' + by.toFixed(1) + '" x2="' + (x + bw - 8) + '" y2="' + by.toFixed(1) + '" stroke="#1a2332" stroke-width="' + Math.max(2, Math.min(5, diameter * 0.26)).toFixed(1) + '" stroke-linecap="round"/>';
  }
  [0.28, 0.72].forEach(t => {
    const bx = (x + bw * t).toFixed(1);
    svg += '<line x1="' + bx + '" y1="' + (y - 4) + '" x2="' + bx + '" y2="' + (y + bh + 4) + '" stroke="#1a2332" stroke-width="2.4"/>';
  });
  svg += dimensionLabelSvg(displayLengthCm(barLengthMm), W / 2, y - 12, 60);
  const foot = 'Ø' + (diameter || '?') + '  ·  ' + packages + ' חבילות' + (weighed ? '  ·  ' + weighed.toFixed(1) + ' ק״ג' : '');
  svg += dimensionLabelSvg(foot, W / 2, y + bh + 18, 190);
  return '<svg data-shape-kind="lift-package" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;max-height:100px;overflow:visible">' + svg + '</svg>';
}

function itemShapeSvg(item = {}) {
  if (isLiftPackageItem(item)) return liftPackageProductionSvg(item);
  if (isRoundPileCageItem(item)) return pileCageProductionSvg(item);
  const spiralSvg = spiralShapeSvg(item);
  const isBench = isBenchBarItem(item);
  const isRoundedEnd = isRoundedEndBarItem(item);
  const segments = shapeSegmentsFromItem(item);
  if (!spiralSvg && isBench && segments.length === 5) return benchBarProductionSvg(segments);
  if (!spiralSvg && isRoundedEnd && segments.length === 3) return roundedEndBarProductionSvg(segments, roundedEndBarRadiusMm(item));
  return spiralSvg || shapeSvg(segments, {
    rotateDegrees: isBench ? 180 : 0,
    shapeKind: isBench ? 'bench-bar' : 'generic-bar',
  });
}

function roundedEndBarProductionSvg(segments, radiusMm = null) {
  const sides = segments.map(segment => Number(segment.length_mm || 0));
  const width = 220;
  const height = 112;
  const left = 56;
  const right = 164;
  const top = 28;
  const bottom = 74;
  const radiusPx = (bottom - top) / 2;
  const tailPx = 30;
  const path = `M ${left + tailPx},${top} H ${left} A ${radiusPx},${radiusPx} 0 0 0 ${left},${bottom} H ${right} A ${radiusPx},${radiusPx} 0 0 0 ${right},${top} H ${right - tailPx}`;
  let svg = `<path d="${path}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${path}" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += sideDimensionSvg([left + tailPx, top], [left, top], sides[0], [110, 50], 16);
  svg += sideDimensionSvg([left, bottom], [right, bottom], sides[1], [110, 50], 18);
  svg += sideDimensionSvg([right, top], [right - tailPx, top], sides[2], [110, 50], 16);
  if (Number.isFinite(Number(radiusMm)) && Number(radiusMm) > 0) {
    svg += `<text x="110" y="67" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#c9621a">R ${displayLengthCm(Number(radiusMm))}</text>`;
  }
  return `<svg data-shape-kind="rounded-end-bar" data-bend-radius-mm="${Number(radiusMm) > 0 ? Number(radiusMm) : ''}" data-base-straight="true" data-end-tails-parallel="true" data-scale-mode="container-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;overflow:visible">${svg}</svg>`;
}

function benchBarProductionSvg(segments) {
  const sides = segments.map(segment => Number(segment.length_mm || 0));
  const width = 260;
  const height = 140;
  const points = [
    [25, 50],
    [62, 82],
    [62, 30],
    [198, 30],
    [198, 82],
    [235, 116],
  ];
  const path = `M ${points.map(point => point.join(',')).join(' L ')}`;
  const center = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  let svg = `<path d="${path}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${path}" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  sides.forEach((value, index) => {
    svg += sideDimensionSvg(points[index], points[index + 1], value, center, index === 0 || index === 4 ? 18 : 16);
  });
  return `<svg data-shape-kind="bench-bar" data-dimension="2d" data-scale-mode="container-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;overflow:visible">${svg}</svg>`;
}

function openUShapeSvg(segments) {
  const [leftLeg, bridge, rightLeg] = segments.map(segment => Number(segment.length_mm || 0));
  const width = 220;
  const height = 100;
  const left = 42;
  const right = 178;
  const top = 24;
  const bottom = 78;
  const midY = (top + bottom) / 2;
  const midX = (left + right) / 2;
  const path = `M ${left},${top} L ${left},${bottom} L ${right},${bottom} L ${right},${top}`;

  let svg = `<path d="${path}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${path}" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

  svg += sideDimensionSvg([left, top], [left, bottom], leftLeg, [midX, midY], 22);
  svg += sideDimensionSvg([left, bottom], [right, bottom], bridge, [midX, midY], 20);
  svg += sideDimensionSvg([right, bottom], [right, top], rightLeg, [midX, midY], 22);

  // 90° היא ברירת המחדל של כיפוף במוט - לא מסמנים אותה בשרטוט.
  // בחישוקים הסימון נשמר - שם יש חוק אחר.

  return `<svg data-shape-kind="open-u" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;max-height:100px;overflow:visible">${svg}</svg>`;
}

function angledOpenStirrupParts(segments) {
  if (!Array.isArray(segments) || segments.length !== 5) return null;
  const lengths = segments.map(segment => Number(segment.length_mm || 0));
  if (lengths.some(length => length <= 0)) return null;
  const [tailA, sideA, sideB, sideC, tailB] = lengths;
  const angleA = Math.abs(Number(segments[0].angle_deg || 0));
  const angleB = Number(segments[1].angle_deg || 0);
  const angleC = Number(segments[2].angle_deg || 0);
  const angleD = Math.abs(Number(segments[3].angle_deg || 0));
  const tailsSimilar = isSimilarDimension(tailA, tailB, 0.2);
  const longSidesSimilar = isSimilarDimension(sideA, sideC, 0.12);
  const hasAngledTails = Math.abs(angleA - 45) <= 2 && Math.abs(angleD - 45) <= 2;
  const hasRectBody = isRightAngle(angleB) && isRightAngle(angleC) && longSidesSimilar;
  if (!tailsSimilar || !hasAngledTails || !hasRectBody) return null;
  return { tailA, bottom: sideA, right: sideB, top: sideC, tailB, angleA, angleD };
}

function closedStirrupSvg(parts) {
  const width = 240;
  const height = 140;
  const horizontal = Math.max(parts.top || 0, parts.bottom || 0, 1);
  const vertical = Math.max(parts.left || 0, parts.right || 0, 1);
  const maxBoxW = 126;
  const maxBoxH = 90;
  const rawRatio = horizontal / vertical;
  const boxW = rawRatio >= 1
    ? maxBoxW
    : Math.max(54, Math.min(maxBoxW, maxBoxH * rawRatio));
  const boxH = rawRatio >= 1
    ? Math.max(54, Math.min(maxBoxH, maxBoxW / rawRatio))
    : maxBoxH;
  const x = (width - boxW) / 2 - 10;
  const y = (height - boxH) / 2 + 4;
  const right = x + boxW;
  const bottom = y + boxH;
  const midX = x + boxW / 2;
  const midY = y + boxH / 2;
  const path = `M ${x.toFixed(1)},${y.toFixed(1)} L ${right.toFixed(1)},${y.toFixed(1)} L ${right.toFixed(1)},${bottom.toFixed(1)} L ${x.toFixed(1)},${bottom.toFixed(1)} Z`;
  const marker = Math.min(28, Math.max(14, Math.min(boxW, boxH) * 0.28));
  const markerX = right - marker;
  const markerY = y + marker;
  const markerPath = `M ${markerX.toFixed(1)},${y.toFixed(1)} L ${markerX.toFixed(1)},${markerY.toFixed(1)} L ${right.toFixed(1)},${markerY.toFixed(1)}`;

  let svg = `<path d="${path}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path d="${path}" fill="none" stroke="#3a5070" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<path data-stirrup-marker="overlap" d="${markerPath}" fill="none" stroke="#1a2332" stroke-width="4" stroke-linecap="square" stroke-linejoin="miter"/>`;
  svg += `<path d="${markerPath}" fill="none" stroke="#3a5070" stroke-width="1.4" stroke-linecap="square" stroke-linejoin="miter"/>`;
  if (parts.tailStart > 0) {
    svg += `<text data-tail-dim="1" x="${(markerX - 4).toFixed(1)}" y="${(y + marker / 2).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.4" paint-order="stroke fill" stroke-linejoin="round">${escapeHtml(displayLengthCm(parts.tailStart))}</text>`;
  }
  if (parts.tailEnd > 0) {
    svg += `<text data-tail-dim="1" x="${((markerX + right) / 2).toFixed(1)}" y="${(markerY + 9).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#1a2332" stroke="white" stroke-width="2.4" paint-order="stroke fill" stroke-linejoin="round">${escapeHtml(displayLengthCm(parts.tailEnd))}</text>`;
  }

  [
    { x: midX, y: y - 11, value: parts.top },
    { x: right + 20, y: midY, value: parts.right },
    { x: midX, y: bottom + 13, value: parts.bottom },
    { x: x - 20, y: midY, value: parts.left },
  ].forEach(label => {
    svg += `<rect x="${(label.x - 18).toFixed(1)}" y="${(label.y - 7).toFixed(1)}" width="36" height="14" rx="3" fill="white" fill-opacity="0.94"/>`;
    svg += `<text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">${escapeHtml(displayLengthCm(label.value))}</text>`;
  });

  [
    [[x, bottom], [x, y], [right, y]],
    [[x, y], [right, y], [right, bottom]],
    [[right, y], [right, bottom], [x, bottom]],
    [[right, bottom], [x, bottom], [x, y]],
  ].forEach(([previous, corner, next]) => {
    svg += rightAngleMarkerSvg(previous, corner, next);
  });

  return `<svg data-shape-kind="closed-stirrup" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;max-height:112px;overflow:visible">${svg}</svg>`;
}

function angledOpenStirrupSvg(parts) {
  const width = 260;
  const height = 140;
  const left = 64;
  const right = 198;
  const top = 32;
  const bottom = 104;
  const tailInset = 24;
  const topTailEnd = [left + tailInset, top + tailInset];
  const bottomTailEnd = [left + tailInset, bottom - tailInset];
  const points = [
    bottomTailEnd,
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
    topTailEnd,
  ];
  const path = 'M ' + points.map(point => point.join(',')).join(' L ');
  const center = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  let svg = '<path d="' + path + '" fill="none" stroke="#1a2332" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>';
  svg += '<path d="' + path + '" fill="none" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

  [parts.tailA, parts.bottom, parts.right, parts.top, parts.tailB].forEach((value, index) => {
    svg += sideDimensionSvg(points[index], points[index + 1], value, center, index === 0 || index === 4 ? 20 : 18);
  });

  svg += angleMarkerSvg(points[0], points[1], points[2], parts.angleA, center);
  svg += rightAngleMarkerSvg(points[1], points[2], points[3]);
  svg += rightAngleMarkerSvg(points[2], points[3], points[4]);
  svg += angleMarkerSvg(points[3], points[4], points[5], parts.angleD, center);

  return '<svg data-shape-kind="angled-open-stirrup" data-scale-mode="print-fit" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:100%;max-height:112px;overflow:visible">' + svg + '</svg>';
}
function shapeSvg(segmentsRaw, opts = {}) {
  try {
    const segments = parseSegments(segmentsRaw);
    const width = 260;
    const height = 140;
    const padding = 46;
    if (!segments.length) {
      return '<svg viewBox="0 0 220 60" style="width:100%;max-height:80px">' +
        '<line x1="12" y1="30" x2="208" y2="30" stroke="#1a2332" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="12" cy="30" r="3" fill="#1a2332"/><circle cx="208" cy="30" r="3" fill="#1a2332"/></svg>';
    }

    if (segments.length === 1) return straightShapeSvg(segments[0]);
    if (isOpenUShape(segments)) return openUShapeSvg(segments);
    const stirrup = closedStirrupParts(segments);
    if (stirrup) return closedStirrupSvg(stirrup);
    const angledOpenStirrup = angledOpenStirrupParts(segments);
    if (angledOpenStirrup) return angledOpenStirrupSvg(angledOpenStirrup);

    const sides = segments.map(segment => Number(segment.length_mm || 0));
    const angles = segments.map(segment => segment.angle_deg);
    const visualSides = separateOverlappingSides(proportionalPrintSides(sides), angles);
    const points = normalizeShapePointsBaseBottom(calcShapePoints(visualSides, angles), opts);

    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min((width - padding * 2) / rangeX, (height - padding * 2) / rangeY);
    const offsetX = padding + ((width - padding * 2) - rangeX * scale) / 2;
    const offsetY = padding + ((height - padding * 2) - rangeY * scale) / 2;
    const mapped = points.map(point => [
      Number((offsetX + (point[0] - minX) * scale).toFixed(1)),
      Number((offsetY + (point[1] - minY) * scale).toFixed(1)),
    ]);
    const path = `M ${mapped.map(point => point.join(',')).join(' L ')}`;
    let svg = `<path d="${path}" fill="none" stroke="#1a2332" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${path}" fill="none" stroke="#3a5070" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;

    const center = [mapped.reduce((sum, point) => sum + point[0], 0) / mapped.length, mapped.reduce((sum, point) => sum + point[1], 0) / mapped.length];
    for (let i = 0; i < mapped.length - 1; i += 1) {
      svg += sideDimensionSvg(mapped[i], mapped[i + 1], sides[i], center, 15);
    }

    for (let i = 1; i < mapped.length - 1; i += 1) {
      const angle = angles[i - 1];
      if (isPrintableBendAngle(angle)) {
        svg += angleMarkerSvg(mapped[i - 1], mapped[i], mapped[i + 1], angle, center);
      }
    }

    return `<svg data-shape-kind="${opts.shapeKind || 'generic-bar'}" data-scale-mode="print-fit" data-proportional-short-bends="1" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;max-height:100px;overflow:visible">${svg}</svg>`;
  } catch {
    return '<svg viewBox="0 0 220 60"><line x1="10" y1="30" x2="210" y2="30" stroke="#ccc" stroke-width="2"/></svg>';
  }
}

function masterCard(allItems, order, printDate, deliveryDate, numPallets) {
  const rows = allItems.map((item, index) => '<tr>' +
    `<td>${index + 1}</td>` +
    `<td><b>Ø${escapeHtml(shapeDiameterFromItem(item) || '?')}</b></td>` +
    `<td>${escapeHtml(item.shape_name || '-')}</td>` +
    `<td class="master-shape-cell">${itemShapeSvg(item)}</td>` +
    `<td>${Math.round((shapeTotalLengthMmFromItem(item) || 0) / 10)}</td>` +
    `<td><b>${item.quantity || 1}</b></td>` +
    `<td>${Number(item.total_weight || 0).toFixed(1)}</td>` +
    '<td class="check-cell">□</td>' +
  '</tr>').join('');

  return '<div class="prod-card master-card">' +
    '<div class="pc-head" style="background:#1a2332;color:#fff;padding:8px 12px;">' +
      '<div><div class="pc-title" style="color:#e07b39;font-size:14px;">★ כרטיסיית מאסטר</div>' +
      `<div class="pc-date" style="color:#8aa;">${escapeHtml(printDate)}</div></div>` +
      `<div style="text-align:left"><div style="font-size:16px;font-weight:900;">${escapeHtml(order.order_num || '')}</div>` +
      `<div style="font-size:10px;color:#8aa;">${deliveryDate ? `מסירה: ${escapeHtml(deliveryDate)}` : ''}</div></div></div>` +
    `<div style="padding:6px 10px;font-size:12px;font-weight:700;border-bottom:1px solid #eee;">${escapeHtml(order.customer_name || '')}</div>` +
    '<table class="master-table"><thead><tr><th>#</th><th>Ø</th><th>צורה</th><th>תרשים</th><th>אורך</th><th>כמות</th><th>ק"ג</th><th>✓</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    `<div class="master-totals">סה"כ: <b>${Number(order.total_weight || 0).toFixed(1)} ק"ג</b> · ${numPallets} משטחים · ${allItems.length} פריטים</div>` +
    `<div class="pc-footer" style="background:#1a2332;color:#8aa;font-size:9px;text-align:center;padding:4px;">★ כרטיסיית מאסטר - לא לאיבוד! · ${escapeHtml(order.order_num || '')}</div>` +
  '</div>';
}

function itemCard(item, order, printDate, rebarWeights) {
  const scanSuffix = item.scan_suffix ? `-${String(item.scan_suffix).replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
  const barcode = `${order.order_num || ''}-${String(item.id).padStart(6, '0')}${scanSuffix}`;
  const segments = shapeSegmentsFromItem(item);
  const visualShapeSvg = shapeSvgForProductionCard(item, segments);
  const title = itemHumanTitle(item);
  const shapeSubtitle = isRoundPileCageItem(item) ? 'כלוב זיון לכלונס עגול' : (item.shape_name ? `כרטיס כיפוף - ${item.shape_name}` : 'כרטיס כיפוף');
  const note = printableItemNote(item.note);
  const structElement = itemStructElement(item);
  const diameter = shapeDiameterFromItem(item);
  const totalLengthMm = shapeTotalLengthMmFromItem(item);
  const diaNum = Number(diameter) || 0;
  // Fractional diameters (e.g. 5.5) are not integer table keys — try the exact
  // value, then the rounded key, then the round-bar formula d² × 0.00617.
  const kgPerMeter = rebarWeights[diaNum] ?? rebarWeights[Math.round(diaNum)] ?? (diaNum > 0 ? diaNum * diaNum * 0.00617 : 0);
  const weight = item.total_weight && item.total_weight > 0
    ? Number(item.total_weight).toFixed(2)
    : (kgPerMeter ? (Math.round((totalLengthMm || 0) / 1000 * kgPerMeter * (item.quantity || 1) * 10) / 10).toFixed(2) : '0.00');


  // Every card can be picked or dropped on the sheet itself, the way photos are
  // picked, so the operator sees exactly what they are choosing.
  return '<div class="prod-card" data-picked="1">' +
    '<button type="button" class="pc-pick" title="סמן / בטל כרטיסייה זו" onclick="togglePickedCard(this,event)">✓</button>' +
    '<div class="pc-head">' +
      `<div><div class="pc-title">${escapeHtml(title)}</div><div class="pc-date">${escapeHtml(shapeSubtitle)} · ${escapeHtml(printDate)}</div></div>` +
      `<div class="pc-top-barcode"><div class="bc-font-top">${escapeHtml(barcode)}</div><div class="bc-label">${escapeHtml(barcode)}</div></div>` +
    '</div>' +
    '<div class="pc-order-row">' +
      '<div class="pc-order-label">הזמנה מס:</div>' +
      `<div class="pc-order-barcode"><div class="bc-font-mid">${escapeHtml(order.order_num || '')}</div><div class="bc-ord-text">${escapeHtml(order.order_num || '')}</div></div>` +
      `<div class="pc-pallet">משטח: <b>${item._palletNum || 1}</b></div>` +
    '</div>' +
    '<div class="pc-wq-row">' +
      `<div class="pc-wq-cell"><span class="wq-lbl">ק"ג:</span> <span class="wq-val">${weight}</span></div>` +
      '<div class="pc-wq-sep"></div>' +
      `<div class="pc-wq-cell"><span class="wq-lbl">כמות:</span> <span class="wq-val">${item.quantity || 1}</span> יח</div>` +
      '<div class="pc-wq-sep"></div>' +
      `<div class="pc-wq-cell"><span class="wq-lbl">לקוח:</span> <span class="wq-cust">${escapeHtml(order.customer_name || '')}</span></div>` +
    '</div>' +
    `<div class="pc-shape-area">${visualShapeSvg}</div>` +
    '<div class="pc-spec-row">' +
      `<div class="pc-spec-cell"><span class="spec-lbl">קוטר:</span> <b>Ø${escapeHtml(shapeDiameterFromItem(item) || '?')}</b></div>` +
      '<div class="pc-spec-sep"></div>' +
      `<div class="pc-spec-cell"><span class="spec-lbl">אורך פיתוח:</span> <b>${Math.round((Number(totalLengthMm || 0)) / 10)}</b> ס״מ</div>` +
      (structElement ? `<div class="pc-spec-sep"></div><div class="pc-spec-cell"><span class="spec-lbl">איבר:</span> ${escapeHtml(structElement)}</div>` : '') +
    '</div>' +
    (note ? `<div class="pc-note">⚠ ${escapeHtml(note)}</div>` : '') +
    '<div class="pc-footer">' +
      `<div class="bc-font-footer">${escapeHtml(barcode)}</div>` +
      `<div class="pc-brand">SYNTA<br><span class="pc-brand-num">${item._palletNum || 1}</span></div>` +
    '</div>' +
  '</div>';
}

module.exports = {
  escapeHtml,
  printableItemNote,
  shapeSvg,
  itemShapeSvg,
  spiralShapeSvg,
  masterCard,
  itemCard,
  attachOrderLineNumbers,
  itemHumanTitle,
  itemOrderLineLabel,
  parseSegments,
  shapeSegmentsFromItem,
  shapeDiameterFromItem,
  shapeTotalLengthMmFromItem,
  isPrintableBendAngle,
  shapeSvgHasAngleLabels,
  isRoundPileCageItem,
  pileCageProductionSvg,
  shapeSvgForProductionCard,
  isLiftPackageItem,
  liftPackageProductionSvg,
};
