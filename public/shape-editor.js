window.IRONBEND_ASSET_VERSION = "shape-preview-stability-v1";
// ── REBAR WEIGHTS ─────────────────────────────────────────────────
function sharedKgPerMeter(diameter) {
  if (window.IronBendRebar?.kgPerMeter) return window.IronBendRebar.kgPerMeter(diameter);
  const d = Number(diameter);
  return Number.isFinite(d) && d > 0 ? d * d * 0.00617 : 0;
}

function displayNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Number(number.toFixed(Math.max(0, Number(digits) || 0))).toLocaleString('he-IL', {
    maximumFractionDigits: Math.max(0, Number(digits) || 0),
  });
}

// Geometry is always stored in millimetres.  The editor, the schedule and
// production cards all speak centimetres to the operator, so SVG labels must
// go through one formatter instead of printing the raw model value.
function formatLengthCmFromMm(value, { withUnit = true, fallback = '—' } = {}) {
  const millimetres = Number(value);
  if (!Number.isFinite(millimetres)) return fallback;
  const centimetres = Math.round(millimetres) / 10;
  const formatted = Number(centimetres.toFixed(1)).toLocaleString('he-IL', {
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  return withUnit ? `${formatted} ס״מ` : formatted;
}

// Mesh and pile form fields are already authored in centimetres. Keep their
// display contract explicit so a centimetre spacing is never divided again.
function formatLengthCm(value, options = {}) {
  const centimetres = Number(value);
  if (!Number.isFinite(centimetres)) return options.fallback ?? '—';
  return formatLengthCmFromMm(centimetres * 10, options);
}

function dimensionTagWidth(value, min = 44, max = 76) {
  return Math.max(min, Math.min(max, String(value).length * 6.4 + 16));
}

function normalizeReadableLabelAngle(degrees) {
  let angle = ((Number(degrees) % 360) + 360) % 360;
  if (angle > 180) angle -= 360;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  return angle;
}

function rotatePointListAroundBounds(points, degrees = 0) {
  const rotation = Number(degrees || 0);
  if (!rotation || !Array.isArray(points) || points.length < 2) return points;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

// In a true-3D product the view may rotate, but the manufactured XYZ data
// must not.  Rotate a copy of the camera-space source around its own centre.
function rotate3DPointsForView(points, degrees = 0) {
  const rotation = Number(degrees || 0);
  if (!rotation || !Array.isArray(points) || points.length < 2) return points;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map(([x, y, z]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, z];
  });
}

// ── SEGMENT COLOR PALETTE ─────────────────────────────────────────
const SEG_COLORS = [
  '#e07b39', // כתום  – צלע א
  '#3a7bd5', // כחול  – צלע ב
  '#22a85a', // ירוק  – צלע ג
  '#c94f7c', // ורוד  – צלע ד
  '#9b59b6', // סגול  – צלע ה
  '#0ea5a0', // ציאן  – צלע ו
  '#e74c3c', // אדום  – צלע ז
  '#d4ac0d', // זהב   – צלע ח
];

// ── SHAPE PRESETS ──────────────────────────────────────────────────
// sides: lengths in mm (defaults), angles: bend angles in degrees between sides
const ROUND_PILE_CAGE_STANDARD_TEMPLATE = 'standard-60-300-rest';

function buildRoundPileCageStandardZones(pileLengthCm) {
  const total = Math.max(0, Number(pileLengthCm) || 0);
  const noWrapLength = Math.min(60, total);
  const denseLength = Math.min(300, Math.max(0, total - noWrapLength));
  const remainingLength = Math.max(0, total - noWrapLength - denseLength);
  const zones = [];
  if (noWrapLength > 0) zones.push({ name: 'A', length: noWrapLength, noWrap: true });
  if (denseLength > 0) zones.push({ name: 'B', length: denseLength, pitch: 10, noWrap: false });
  if (remainingLength > 0) zones.push({ name: 'C', length: remainingLength, pitch: 20, noWrap: false });
  return zones;
}

function matchesRoundPileCageStandardZones(pile = {}) {
  const actual = Array.isArray(pile.spiralZones) ? pile.spiralZones : [];
  const expected = buildRoundPileCageStandardZones(pile.pileLength);
  if (actual.length !== expected.length) return false;
  return expected.every((zone, index) => {
    const candidate = actual[index] || {};
    const noWrap = candidate.noWrap === true || candidate.noWrap === 1 || candidate.noWrap === 'true';
    return String(candidate.name || '') === zone.name
      && Number(candidate.length) === Number(zone.length)
      && noWrap === Boolean(zone.noWrap)
      && (zone.noWrap || Number(candidate.pitch) === Number(zone.pitch));
  });
}

const SHAPE_PRESETS = [
  { id: 's1',  name: 'מוט ישר',           family: 'bars', category: 'פיגורה', icon: 'straight', bends: 0, sides: [1000],                         angles: [],                    emoji: '➖' },
  { id: 's2',  name: 'צורה 2',     family: 'bars', category: 'פיגורה', icon: 'l', bends: 1, sides: [500, 200],                     angles: [90],                  emoji: '⌐' },
  { id: 's3',  name: 'צורה 3',      family: 'bars', category: 'פיגורה', icon: 'u', bends: 2, sides: [300, 600, 300],                angles: [90, 90],              emoji: '∪' },
  { id: 's16', name: 'קצה מעוגל',    family: 'bars', category: 'פיגורה', icon: 'rounded-u', bends: 2, sides: [80, 240, 80],          angles: [90, 90], shapeType: 'rounded_end_bar', roundedBends: true, radiusMm: null, emoji: '∪' },
  { id: 's4',  name: 'צורה 4',      family: 'bars', category: 'פיגורה', icon: 'z', bends: 2, sides: [300, 400, 300],                angles: [135, 135],            emoji: 'Z' },
  { id: 's5',  name: 'צורה 5',      family: 'bars', category: 'פיגורה', icon: 's', bends: 3, sides: [200, 300, 300, 200],           angles: [135, 135, 135],       emoji: 'S' },
  { id: 's6',  name: 'צורה 6',  family: 'bars', category: 'קלמרה', icon: 'hook', bends: 3, sides: [200, 400, 400, 200],           angles: [90, 180, 90],         emoji: '⌡' },
  { id: 's7',  name: 'צורה 7',   family: 'bars', category: 'ציפורים', icon: 'open-u', bends: 3, sides: [200, 500, 500, 200],           angles: [90, 90, 90],          emoji: '┓' },
  { id: 's8',  name: 'צורה 8',  family: 'bars', category: 'חישוק', icon: 'stirrup', bends: 4, sides: [400, 200, 400, 200],           angles: [90, 90, 90, 90],      emoji: '▢' },
  { id: 's9',  name: 'צורה 9', family: 'bars', category: 'חישוק', icon: 'stirrup-square', bends: 4, sides: [300, 300, 300, 300],           angles: [90, 90, 90, 90],      emoji: '▣' },
  { id: 's10', name: 'צורה 10', family: 'bars', category: 'משקפיים', icon: 'multi', bends: 5, sides: [150, 200, 400, 200, 400, 150], angles: [90, 90, 90, 90, 90], emoji: '⌂' },
  { id: 's11', name: 'צורה 11',  family: 'bars', category: 'משקפיים', icon: 'polygon', bends: 6, sides: [150, 150, 400, 150, 400, 150, 150], angles: [90,90,90,90,90,90], emoji: '⬡' },
  { id: 's13', name: 'צורה 12', family: 'bars', category: 'פיגורה', icon: 'w', bends: 4, sides: [200, 300, 300, 300, 200], angles: [135, 90, 90, 135], emoji: 'W' },
  { id: 's14', name: 'צורה 13',    family: 'bars', category: 'פיגורה', icon: 'c', bends: 4, sides: [300, 200, 400, 200, 300], angles: [90, 90, 90, 90],   emoji: 'C' },
  { id: 's15', name: 'ספסל',       family: 'bars', category: 'פיגורה', icon: 'bench', bends: 4, sides: [280, 170, 300, 170, 280], angles: [90, 90, 90, 90], is3d: 1, azAngles: [0, 90, 90, 90, 90], elAngles: [90, 0, 0, 0, 90], shapeType: 'bench_bar', emoji: '🪑' },
  { id: 'mesh1', name: 'רשת', family: 'mesh', icon: 'mesh', bends: 0, length: 600, width: 250, longitudinalDiameter: 8, longitudinalSpacing: 20, transverseDiameter: 8, transverseSpacing: 20, edgeLeft: 0, edgeRight: 0, edgeTop: 0, edgeBottom: 0, emoji: '#', specialty: 'mesh' },
  { id: 'round-pile-cage', name: 'כלוב כלונס עגול', family: 'piles', icon: 'pile', bends: 0, roundPileCage: true, pileDiameter: 60, pileLength: 1200, longitudinalBars: 10, longitudinalDiameter: 20, straightBarCount: 5, bentBarCount: 5, straightBarLength: 1200, bentBarLength: 1220, bendLength: 20, barPattern: 'alternate', barSpacingDisplayMode: 'center', spiralDiameter: 8, spiralOuterDiameter: 48, spiralPitch: 20, spiralZones: buildRoundPileCageStandardZones(1200), hoopsEnabled: true, hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: '', hoopStart: 150, hoopSpacing: 300, emoji: '◎', specialty: 'pile' },
  { id: 'spiral1', name: 'ספיראלה', family: 'spirals', icon: 'spiral', bends: 0, barDiameter: 8, spiralDiameter: 400, turns: 20, emoji: '🌀', specialty: 'spiral' },
  { id: 'ring1', name: 'טבעת עגולה', family: 'spirals', icon: 'ring', bends: 0, barDiameter: 18, ringDiameter: 420, spiralDiameter: 420, overlap: 200, turns: 1, shapeType: 'ring', emoji: '⭕', specialty: 'ring' },
  { id: 's12', name: 'צורה מותאמת',  family: 'bars', icon: 'custom', bends: 0, sides: [500],                          angles: [],                    emoji: '✏️', custom: true },
];

const SHAPE_FAMILIES = [
  { id: 'bars',    label: 'מוטות' },
  { id: 'mesh',    label: 'רשת' },
  { id: 'piles',   label: 'כלונסאות' },
  { id: 'spirals', label: 'ספיראלות' },
  { id: 'lifts',   label: 'ליפטים' },
];

SHAPE_PRESETS.push({ id: 'lift-package', name: 'חבילת ליפטים', family: 'lifts', icon: 'lift', bends: 0, diameter: 12, barLength: 1200, weighedKg: 0, quantity: 0, emoji: '📦', specialty: 'lift' });

const SHAPE_CATEGORY_FILTERS = ['הכל', 'חישוק', 'פיגורה', 'ספירלים', 'ציפורים', 'משקפיים', 'קלמרה'];
const SHAPE_SIDE_FILTERS = ['הכל', 1, 2, 3, 4, 5, 6, 7, 8];

function shapePresetIconSVG(kind) {
  const stroke = 'stroke="currentColor" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const thin = 'stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".92"';
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="4.2" fill="currentColor"/>`;
  const icons = {
    straight: `<path ${stroke} d="M18 50 H82"/>`,
    l: `<path ${stroke} d="M30 20 V68 H76"/>`,
    u: `<path ${stroke} d="M24 20 V72 H76 V20"/>`,
    'rounded-u': `<path ${stroke} d="M24 20 V58 Q24 74 40 74 H60 Q76 74 76 58 V20"/>`,
    z: `<path ${stroke} d="M22 24 H74 L28 72 H78"/>`,
    s: `<path ${stroke} d="M74 22 H34 C18 22 18 45 35 45 H65 C82 45 82 72 62 72 H24"/>`,
    hook: `<path ${stroke} d="M22 20 V70 H68 C82 70 82 48 68 48"/>`,
    'open-u': `<path ${stroke} d="M24 22 V72 H78 V44"/>`,
    stirrup: `<rect x="22" y="18" width="56" height="58" rx="3" ${stroke}/><path ${thin} d="M61 34 H78 V51"/>`,
    'stirrup-square': `<rect x="24" y="24" width="52" height="52" rx="3" ${stroke}/><path ${thin} d="M58 38 H76 V55"/>`,
    multi: `<path ${stroke} d="M17 66 H35 V35 H56 V66 H80"/>`,
    polygon: `<path ${stroke} d="M50 16 L78 32 V66 L50 82 L22 66 V32 Z"/>`,
    w: `<path ${stroke} d="M16 25 L31 74 L50 38 L69 74 L84 25"/>`,
    c: `<path ${stroke} d="M77 24 H31 V74 H77"/>`,
    bench: `<path ${stroke} d="M10 38 L31 64 V28 H69 V62 L89 78"/>`,
    mesh: `<path ${thin} d="M20 24 H82 M20 40 H82 M20 56 H82 M20 72 H82 M28 16 V80 M44 16 V80 M60 16 V80 M76 16 V80"/>`,
    pile: `<circle cx="50" cy="50" r="30" ${thin}/><circle cx="50" cy="50" r="21" ${thin} opacity=".45"/>${dot(50, 20)}${dot(71, 29)}${dot(80, 50)}${dot(71, 71)}${dot(50, 80)}${dot(29, 71)}${dot(20, 50)}${dot(29, 29)}`,
    spiral: `<path ${thin} d="M39 84 A36 36 0 1 1 67 80"/><circle cx="50" cy="48" r="26" ${thin}/><circle cx="50" cy="48" r="16" ${thin}/><path ${thin} d="M50 40 A8 8 0 1 1 42 48"/><path stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" d="M12 48 H88 M12 42 V54 M88 42 V54"/>`,
    ring: `<circle cx="50" cy="48" r="28" ${thin}/><path ${thin} d="M30 68 C37 76 47 80 59 77"/>`,
    custom: `<path ${stroke} d="M24 70 L34 50 L62 22 L78 38 L50 66 Z"/><path ${thin} d="M58 26 L74 42"/>`,
  };
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${icons[kind] || icons.straight}</svg>`;
}

function liftPresetIconSVG() {
  return '<svg viewBox="0 0 40 40" width="40" height="40"><rect x="7" y="13" width="26" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="10" y1="18" x2="30" y2="18" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="23" x2="30" y2="23" stroke="currentColor" stroke-width="1.5"/><line x1="15" y1="11" x2="15" y2="30" stroke="currentColor" stroke-width="2"/><line x1="25" y1="11" x2="25" y2="30" stroke="currentColor" stroke-width="2"/></svg>';
}

function isStandaloneRingShape(shape = {}) {
  return shape?.specialty === 'ring'
    || shape?.shapeType === 'ring'
    || shape?.presetId === 'ring1'
    || shape?.id === 'ring1';
}

function isBenchBarShape(shape = {}) {
  const name = shape?.presetName || shape?.shapeName || shape?.name || shape?.displayName || '';
  return shape?.shapeType === 'bench_bar'
    || shape?.presetId === 's15'
    || shape?.id === 's15'
    || /^\s*(?:ספסל|bench)\s*$/i.test(String(name));
}

function isRoundedEndBarShape(shape = {}) {
  return shape?.shapeType === 'rounded_end_bar'
    || shape?.roundedBends === true
    || shape?.presetId === 's16'
    || shape?.id === 's16';
}

function shapePreviewRotation(shape = {}) {
  const explicit = Number(shape?.previewRotation);
  if (Number.isFinite(explicit)) return explicit;
  return 0;
}

// ── GEOMETRY ──────────────────────────────────────────────────────
function calcShapePoints(sides, angles) {
  const pts = [[0, 0]];
  let dir = 0; // degrees, 0=right, 90=down (screen coords)
  for (let i = 0; i < sides.length; i++) {
    const rad = dir * Math.PI / 180;
    const [px, py] = pts[pts.length - 1];
    pts.push([px + sides[i] * Math.cos(rad), py + sides[i] * Math.sin(rad)]);
    if (i < angles.length) {
      dir -= (180 - angles[i]); // left-turn convention (standard for rebar)
    }
  }
  return pts;
}

function normalizeShapePointsBaseBottom(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return points;
  let longest = { index: 0, length: 0, angle: 0 };
  for (let i = 0; i < points.length - 1; i++) {
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
  if (bodyY > baseY) {
    rotated = rotated.map(([x, y]) => [x, baseY + (baseY - y)]);
  }
  return rotatePointListAroundBounds(rotated, opts.rotateDegrees);
}

const COUNT_PICKER_NAMES = {
  1: 'קו ישר',
  2: 'צורת L',
  3: 'צורת ח',
  4: 'ריבוע / מלבן',
  5: 'מחומש',
  6: 'משושה',
  7: 'שבע צלעות',
  8: 'שמונה צלעות'
};

function countPickerShapeSVG(count) {
  const n = Number(count);
  const style = 'fill:none;stroke:#0c567a;stroke-width:9;stroke-linecap:round;stroke-linejoin:round';
  const guide = 'fill:none;stroke:#d9e5ee;stroke-width:2;stroke-dasharray:4 5';
  const dot = p => `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="#22a85a"/>`;
  const path = pts => `<path d="${pts.map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join(' ')}" style="${style}"/>` + pts.map(dot).join('');

  if (n === 1) return `<svg viewBox="0 0 112 80" aria-label="קו ישר">${path([[22,40],[90,40]])}</svg>`;
  if (n === 2) return `<svg viewBox="0 0 112 80" aria-label="צורת L">${path([[26,22],[26,58],[84,58]])}</svg>`;
  if (n === 3) return `<svg viewBox="0 0 112 80" aria-label="צורת ח">${path([[24,18],[24,58],[88,58],[88,18]])}</svg>`;
  if (n === 4) return `<svg viewBox="0 0 112 80" aria-label="ריבוע"><rect x="27" y="16" width="58" height="48" rx="3" style="${style}"/><rect x="27" y="16" width="58" height="48" rx="3" style="${guide}"/></svg>`;

  const sides = Math.max(5, n);
  const r = sides <= 6 ? 27 : 29;
  const cx = 56, cy = 40;
  const pts = Array.from({ length:sides }, (_, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / sides;
    return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))];
  });
  return `<svg viewBox="0 0 112 80" aria-label="${COUNT_PICKER_NAMES[n] || `${n} צלעות`}">${path([...pts, pts[0]])}</svg>`;
}

// ── TRUE 3D GEOMETRY (azimuth + elevation per segment) ────────────
// azAngles[i]: rotation in XY plane from +X axis (degrees, 0=right, 90=forward)
// elAngles[i]: tilt from XY plane toward +Z (degrees, 0=flat, 90=straight up)
// azAngles[i] = RELATIVE turn in XY plane from previous segment direction (degrees)
//   0 = continue straight ahead   90 = turn left 90°   -90 = turn right 90°
// elAngles[i] = absolute tilt from XY plane (degrees)
function calcShapePoints3D(sides, azAngles, elAngles) {
  const pts = [[0, 0, 0]];
  let cumAz = 0; // accumulated azimuth direction (degrees)
  for (let i = 0; i < sides.length; i++) {
    cumAz += (azAngles && azAngles[i] != null) ? azAngles[i] : 0;
    const az    = cumAz * Math.PI / 180;
    const elDeg = (elAngles && elAngles[i] != null) ? elAngles[i] : 0;
    const el    = elDeg * Math.PI / 180;
    const [px, py, pz] = pts[pts.length - 1];
    const cosEl = Math.cos(el);
    pts.push([
      px + sides[i] * cosEl * Math.cos(az),
      py + sides[i] * cosEl * Math.sin(az),
      pz + sides[i] * Math.sin(el),
    ]);
  }
  return pts;
}

function shapeSVGPath(sides, angles, w, h, padding = 14, opts = {}) {
  if (!sides || sides.length === 0) return { path: '', pts: [] };
  const pts = normalizeShapePointsBaseBottom(calcShapePoints(sides, angles), opts);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scale = Math.min((w - padding*2) / rangeX, (h - padding*2) / rangeY);
  const offX = padding + ((w - padding*2) - rangeX * scale) / 2;
  const offY = padding + ((h - padding*2) - rangeY * scale) / 2;
  const mapped = pts.map(([x, y]) => [
    offX + (x - minX) * scale,
    offY + (y - minY) * scale,
  ]);
  const path = 'M ' + mapped.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L ');
  return { path, pts: mapped };
}

// A bench is manufactured as a real 3D bar, but its 2D schedule projection is
// the conventional five-leg elevation: angled feet, two uprights, and a top
// bridge. Keep this projection stable anywhere the user explicitly chooses 2D.
function benchBarSVGPath(sides, w, h, padding = 14, opts = {}) {
  const values = Array.isArray(sides) ? sides.map(value => Math.max(1, Number(value) || 0)) : [];
  if (values.length !== 5) return shapeSVGPath(values, [], w, h, padding);
  const [leftFoot, leftRise, bridge, rightDrop, rightFoot] = values;
  const leftProjection = leftFoot / Math.SQRT2;
  const rightProjection = rightFoot / Math.SQRT2;
  const leftVerticalProjection = Math.min(leftProjection, leftRise * 0.72);
  const raw = [
    [0, leftRise - leftVerticalProjection],
    [leftProjection, leftRise],
    [leftProjection, 0],
    [leftProjection + bridge, 0],
    [leftProjection + bridge, rightDrop],
    [leftProjection + bridge + rightProjection, rightDrop + rightProjection],
  ];
  const visualPoints = rotatePointListAroundBounds(raw, opts.rotateDegrees);
  const xs = visualPoints.map(point => point[0]);
  const ys = visualPoints.map(point => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeY);
  const offX = padding + ((w - padding * 2) - rangeX * scale) / 2;
  const offY = padding + ((h - padding * 2) - rangeY * scale) / 2;
  const pts = visualPoints.map(([x, y]) => [
    offX + (x - minX) * scale,
    offY + (y - minY) * scale,
  ]);
  const path = 'M ' + pts.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' L ');
  return { path, pts };
}

function roundedEndBarEditorSVG(sides, w = 300, h = 260, opts = {}) {
  const values = Array.isArray(sides) ? sides.map(value => Math.max(1, Number(value) || 0)) : [];
  if (values.length !== 3) return '';
  const left = Math.max(34, w * 0.2);
  const right = Math.min(w - 34, w * 0.8);
  const top = Math.max(26, h * 0.14);
  const bottom = Math.min(h - 54, h * 0.72);
  const radiusPx = Math.max(16, Math.min(34, (right - left) * 0.12, (bottom - top) * 0.32));
  const path = `M ${left} ${top} L ${left} ${bottom - radiusPx} Q ${left} ${bottom} ${left + radiusPx} ${bottom} L ${right - radiusPx} ${bottom} Q ${right} ${bottom} ${right} ${bottom - radiusPx} L ${right} ${top}`;
  const segments = [
    [left, top, left, bottom - radiusPx / 2],
    [left + radiusPx, bottom, right - radiusPx, bottom],
    [right, bottom - radiusPx / 2, right, top],
  ];
  let html = `<path d="${path}" fill="none" stroke="#3d5e78" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" data-shape-kind="rounded-end-bar"/>`;
  segments.forEach((segment, index) => {
    const [x1, y1, x2, y2] = segment;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const x = horizontal ? mx : mx + (index === 0 ? -28 : 28);
    const y = horizontal ? my + 27 : my;
    html += `<g data-se-focus="bar-side-${index}" data-seg-click="${index}" style="cursor:pointer"><rect x="${(x - 22).toFixed(1)}" y="${(y - 10).toFixed(1)}" width="44" height="20" rx="4" fill="#fff" stroke="#9aa3b2"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#111827">${formatLengthCmFromMm(values[index])}</text></g>`;
  });
  const radiusMm = Number(opts.radiusMm);
  const radiusLabel = Number.isFinite(radiusMm) && radiusMm > 0 ? `R ${formatLengthCmFromMm(radiusMm)}` : 'R אוטומטי';
  html += `<text x="${(w / 2).toFixed(1)}" y="${(bottom - 16).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#c9621a">${radiusLabel}</text>`;
  return html;
}


function isSimilarShapeDimension(a, b, tolerance = 0.12) {
  const av = Math.abs(Number(a) || 0);
  const bv = Math.abs(Number(b) || 0);
  const max = Math.max(av, bv);
  if (max <= 0) return false;
  return Math.abs(av - bv) <= Math.max(10, max * tolerance);
}

function isRightBendAngle(angle) {
  const a = Math.abs(Number(angle));
  return Math.abs(a - 90) < 0.001;
}

function detectClosedStirrupParts(sides, angles) {
  const values = Array.isArray(sides) ? sides.map(Number) : [];
  if (values.length < 4 || values.some(v => !Number.isFinite(v) || v <= 0)) return null;
  const checkedAngles = Array.isArray(angles) ? angles.slice(0, Math.min(4, values.length - 1)) : [];
  if (checkedAngles.length && !checkedAngles.every(isRightBendAngle)) return null;

  if (values.length >= 5) {
    const tailStart = values[0];
    const right = values[1];
    const top = values[2];
    const left = values[3];
    const bottom = values[4];
    const tailEnd = values[5] || 0;
    const maxBody = Math.max(right, top, left, bottom);
    if (
      tailStart <= maxBody * 0.45 &&
      (!tailEnd || tailEnd <= maxBody * 0.45) &&
      isSimilarShapeDimension(right, left) &&
      isSimilarShapeDimension(top, bottom)
    ) {
      return {
        top, right, bottom, left, tailStart, tailEnd,
        sideMap: [2, 1, 4, 3],
        tailMap: [0, values.length >= 6 ? 5 : null],
      };
    }
  }

  if (isSimilarShapeDimension(values[0], values[2]) && isSimilarShapeDimension(values[1], values[3])) {
    return {
      top: values[0], right: values[1], bottom: values[2], left: values[3],
      tailStart: values[4] || 0, tailEnd: 0,
      sideMap: [0, 1, 2, 3],
      tailMap: [values.length >= 5 ? 4 : null, null],
    };
  }

  return null;
}

function renderClosedStirrupEditor2D(parts, sides, w, h, opts = {}) {
  const padding = opts.padding || 38;
  const horizontal = Math.max(parts.top || 0, parts.bottom || 0, 1);
  const vertical = Math.max(parts.left || 0, parts.right || 0, 1);
  const scale = Math.min((w - padding * 2 - 54) / horizontal, (h - padding * 2 - 24) / vertical);
  const boxW = Math.max(56, horizontal * scale);
  const boxH = Math.max(48, vertical * scale);
  const x = padding + ((w - padding * 2) - boxW) / 2 - 8;
  const y = padding + ((h - padding * 2) - boxH) / 2 + 4;
  const right = x + boxW;
  const bottom = y + boxH;
  const midX = x + boxW / 2;
  const midY = y + boxH / 2;
  const activeSeg = opts.activeSeg ?? -1;
  const bodyStroke = '#1f3345';
  const highlight = '#2979ff';
  const previewRotation = Number(opts.rotateDegrees || 0);
  const rotationRadians = previewRotation * Math.PI / 180;
  const rotationCos = Math.cos(rotationRadians);
  const rotationSin = Math.sin(rotationRadians);
  const rotatePoint = (px, py) => {
    if (!previewRotation) return [px, py];
    const dx = px - w / 2;
    const dy = py - h / 2;
    return [w / 2 + dx * rotationCos - dy * rotationSin, h / 2 + dx * rotationSin + dy * rotationCos];
  };
  const pathBetween = (x1, y1, x2, y2) => {
    const [rx1, ry1] = rotatePoint(x1, y1);
    const [rx2, ry2] = rotatePoint(x2, y2);
    return `M ${rx1.toFixed(1)} ${ry1.toFixed(1)} L ${rx2.toFixed(1)} ${ry2.toFixed(1)}`;
  };
  const label = (sideIndex, lx, ly, rot, value) => {
    const isAct = sideIndex === activeSeg;
    const stroke = isAct ? '#ff4047' : '#9aa3b2';
    const fill = isAct ? '#fff4f4' : '#ffffff';
    const labelValue = formatLengthCmFromMm(value);
    const tagW = dimensionTagWidth(labelValue);
    const [x, y] = rotatePoint(lx, ly);
    const labelRotation = normalizeReadableLabelAngle(rot + previewRotation);
    return `<g data-se-focus="bar-side-${sideIndex}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${labelRotation.toFixed(1)})" data-seg-click="${sideIndex}" style="cursor:pointer">
      <rect x="${(-tagW/2).toFixed(1)}" y="-8" width="${tagW}" height="16" rx="3" fill="${fill}" stroke="${stroke}" stroke-width=".8"/>
      <text x="0" y="4" text-anchor="middle" font-size="10" font-family="Heebo,Arial" font-weight="800" fill="#111827">${svgEscape(labelValue)}</text>
    </g>`;
  };
  const angleMark = (cx, cy, sx, sy) => {
    const m = 9;
    const p1 = rotatePoint(cx + sx * m, cy);
    const p2 = rotatePoint(cx + sx * m, cy + sy * m);
    const p3 = rotatePoint(cx, cy + sy * m);
    return `<path d="M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} L ${p3[0].toFixed(1)} ${p3[1].toFixed(1)}" fill="none" stroke="#c4c8cf" stroke-width="2"/>`;
  };
  const clickLine = (i, x1, y1, x2, y2) => `<path d="${pathBetween(x1, y1, x2, y2)}" stroke="transparent" stroke-width="16" fill="none" data-se-focus="bar-side-${i}" data-seg-click="${i}" style="cursor:pointer"/>`;
  let html = `<g data-shape-kind="closed-stirrup" data-stirrup-marker="overlap">`;
  const bodySegments = [
    [parts.sideMap[0], x, y, right, y],
    [parts.sideMap[1], right, y, right, bottom],
    [parts.sideMap[2], right, bottom, x, bottom],
    [parts.sideMap[3], x, bottom, x, y],
  ];
  bodySegments.forEach(seg => {
    if (seg[0] == null) return;
    const color = bodyStroke;
    const path = pathBetween(seg[1], seg[2], seg[3], seg[4]);
    html += `<path d="${path}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" data-se-focus="bar-all bar-side-${seg[0]}" data-seg-click="${seg[0]}" style="cursor:pointer"/>`;
    if (seg[0] !== activeSeg) html += `<path d="${path}" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  bodySegments.forEach(seg => { if (seg[0] != null) html += clickLine(...seg); });
  html += angleMark(x, y, 1, 1) + angleMark(right, y, -1, 1) + angleMark(right, bottom, -1, -1) + angleMark(x, bottom, 1, -1);
  html += label(parts.sideMap[0], midX, y - 22, 0, parts.top);
  html += label(parts.sideMap[1], right + 22, midY, 90, parts.right);
  html += label(parts.sideMap[2], midX, bottom + 22, 0, parts.bottom);
  html += label(parts.sideMap[3], x - 22, midY, -90, parts.left);

  const drawTail = (sideIndex, lenValue, offset, flip = 1) => {
    if (sideIndex == null || !lenValue) return '';
    const tailPx = Math.max(24, Math.min(48, Number(lenValue) * scale));
    const sx = right - 2 - offset;
    const sy = y + 7 + offset;
    const ex = sx - tailPx * 0.72;
    const ey = sy + tailPx * 0.38 * flip;
    const isAct = sideIndex === activeSeg;
    const stroke = isAct ? highlight : '#111827';
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    const [rsx, rsy] = rotatePoint(sx, sy);
    const [rex, rey] = rotatePoint(ex, ey);
    return `<g data-se-focus="bar-side-${sideIndex}" data-seg-click="${sideIndex}" style="cursor:pointer">
      <path d="M ${rsx.toFixed(1)} ${rsy.toFixed(1)} L ${rex.toFixed(1)} ${rey.toFixed(1)}" stroke="rgba(0,0,0,.12)" stroke-width="9" stroke-linecap="round" fill="none"/>
      <path d="M ${rsx.toFixed(1)} ${rsy.toFixed(1)} L ${rex.toFixed(1)} ${rey.toFixed(1)}" stroke="${stroke}" stroke-width="4" stroke-linecap="round" fill="none"/>
      ${label(sideIndex, mx + 14, my - 10, -25, lenValue)}
    </g>`;
  };
  html += drawTail(parts.tailMap[0], parts.tailStart, 0, -1);
  html += drawTail(parts.tailMap[1], parts.tailEnd, 16, 1);
  html += `</g>`;
  return html;
}

// ── OVERLAP OFFSET ────────────────────────────────────────────────
// Returns array of depth-offsets (signed px) for each segment.
// Overlapping parallel segments get ±gap — rendered with a DIAGONAL
// "depth" shift so they appear stacked like real bundled rebar,
// not just shifted sideways (which looks unnatural).
function computeSegOffsets(pts2d, barW) {
  const n = pts2d.length - 1;
  if (n <= 0) return [];
  const segs = pts2d.slice(0, -1).map(([x1,y1], i) => {
    const [x2,y2] = pts2d[i+1];
    const dx=x2-x1, dy=y2-y1, len=Math.sqrt(dx*dx+dy*dy)||1;
    let angle = Math.atan2(dy,dx)*180/Math.PI; if (angle<0) angle+=180;
    return { x1,y1,x2,y2, cx:(x1+x2)/2, cy:(y1+y2)/2,
             ux:dx/len, uy:dy/len, nx:-dy/len, ny:dx/len, angle, len };
  });
  const offsets = new Array(n).fill(0);
  const gap = barW * 1.6;
  for (let i=0; i<n; i++) {
    for (let j=i+1; j<n; j++) {
      const si=segs[i], sj=segs[j];
      const da = Math.abs(si.angle - sj.angle);
      if (da>20 && da<160) continue;
      const dcx=sj.cx-si.cx, dcy=sj.cy-si.cy;
      const perp = Math.abs(dcx*si.nx + dcy*si.ny);
      if (perp > gap*1.5) continue;
      const along = Math.abs(dcx*si.ux + dcy*si.uy);
      if (along > (si.len+sj.len)*0.6) continue;
      if (offsets[i]===0 && offsets[j]===0) { offsets[i]=-gap; offsets[j]=+gap; }
      else if (offsets[i]===0) offsets[i] = offsets[j]>0 ? -gap : +gap;
      else if (offsets[j]===0) offsets[j] = offsets[i]>0 ? -gap : +gap;
    }
  }
  return offsets;
}

// Diagonal "depth" direction for overlapping segments.
// Upper-right = "closer to viewer" in isometric convention.
// Both axes equal → clean 45° diagonal that reads as depth, not sideways shift.
const OVLP_DX =  0.707;   // screen-X component of depth vector
const OVLP_DY = -0.707;   // screen-Y component (negative = upward in screen)

// ── 3D ISOMETRIC SVG ──────────────────────────────────────────────
// Projects a flat 2D rebar shape into an isometric 3D view.
// The rebar lies in the XY plane; we view from above-right at 30°.
// ── 3D ISOMETRIC RENDER WITH XYZ AXES ────────────────────────────
// opts.showAxes   – show X/Y/Z axis indicator (default true when w>=120)
// opts.showDims   – show segment length labels
// opts.showBends  – show bend angle labels
// opts.dark       – use dark background palette (default true inside editor)
function shape3DSVG(sides, angles, w, h, diameterMm = 12, opts = {}) {
  if (!sides || sides.length === 0)
    return '<text x="50%" y="50%" text-anchor="middle" fill="#7a93ab" font-size="12">אין צורה</text>';

  const showAxes = opts.showAxes !== false && w >= 100;
  const showDims = opts.showDims !== false && w >= 160;
  const showBends = opts.showBends !== false && w >= 180;
  const compactLabels = opts.compactLabels !== false;
  const dark     = opts.dark !== false;
  const labelClr = dark ? '#e8edf3' : '#1a2533';
  const mutedClr = dark ? '#7a93ab' : '#526070';

  // ── Orbit-camera projection ───────────────────────────────────
  // theta: azimuth (rotation around world-Z), phi: elevation (tilt from horizontal)
  // Default theta=45°, phi=45° → matches the classic isometric look.
  const theta = opts.camTheta ?? Math.PI / 4;
  const phi   = opts.camPhi   ?? Math.PI / 4;
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const cosP = Math.cos(phi),   sinP = Math.sin(phi);

  // Build 3D point array (z=0 for flat 2D shapes)
  let pts3d;
  if (opts.azAngles) {
    pts3d = calcShapePoints3D(sides, opts.azAngles, opts.elAngles || []);
    pts3d = rotate3DPointsForView(pts3d, opts.rotateDegrees);
  } else {
    pts3d = normalizeShapePointsBaseBottom(calcShapePoints(sides, angles), { rotateDegrees: opts.rotateDegrees }).map(([x, y]) => [x, y, 0]);
  }

  // Project: rotate around Z by theta, then tilt by phi
  // sx = x·cosθ − y·sinθ
  // sy = −(z·cosφ − (x·sinθ + y·cosθ)·sinφ)   (screen-Y is down, world-Z is up)
  const iso = pts3d.map(([x, y, z]) => {
    const x1 = x * cosT - y * sinT;
    const y1 = x * sinT + y * cosT;
    return [x1, -(z * cosP - y1 * sinP)];
  });
  const sxs = iso.map(p => p[0]), sys = iso.map(p => p[1]);
  const minSX = Math.min(...sxs), maxSX = Math.max(...sxs);
  const minSY = Math.min(...sys), maxSY = Math.max(...sys);

  // Reserve room for axes legend (bottom-left) and labels
  const axPad = showAxes ? 28 : 0;
  const pad   = compactLabels ? 28 : 22 + (showDims ? 32 : 0);
  const avW   = w - pad * 2 - axPad;
  const avH   = h - pad * 2;
  const sc    = Math.min(avW / (maxSX - minSX || 1), avH / (maxSY - minSY || 1));
  const ox    = pad + axPad + ((avW) - (maxSX - minSX) * sc) / 2;
  const oy    = pad + ((avH) - (maxSY - minSY) * sc) / 2;

  const barW    = Math.max(4, Math.min(diameterMm > 0 ? diameterMm * 0.55 : 8, 16));
  const activeSeg = opts.activeSeg ?? -1;
  const BAR_COLOR = dark ? '#b8cfe0' : '#3d5e78';

  // ── Z-LIFT for overlapping parallel segments ─────────────────────
  // 1. Detect overlaps using the flat projected points.
  // 2. If overlaps exist, add a small virtual Z-elevation to each 3D point,
  //    then re-project — shape shows stacked bars connected at bends,
  //    exactly like real bundled rebar viewed isometrically.
  const flatMapped = iso.map(([sx, sy]) => [
    ox + (sx - minSX) * sc,
    oy + (sy - minSY) * sc,
  ]);
  const offsets3d  = computeSegOffsets(flatMapped, barW);
  const hasOverlap = offsets3d.some(o => o !== 0);

  let mapped;
  if (hasOverlap) {
    // Screen-space diagonal offset — keeps the shape flat, avoids Z-lift distortion.
    // Z-lift causes connecting segments to become 3D-diagonal after projection, which
    // makes 90° bends look skewed. Instead we shift each screen-point by a weighted
    // average of its adjacent segment offsets along the isometric depth direction.
    const n = pts3d.length - 1;
    mapped = flatMapped.map((pt, i) => {
      let sum = 0, cnt = 0;
      if (i > 0 && offsets3d[i - 1] !== 0) { sum += offsets3d[i - 1]; cnt++; }
      if (i < n && offsets3d[i]     !== 0) { sum += offsets3d[i];     cnt++; }
      if (cnt === 0) return pt;
      const off = sum / cnt; // ±barW*1.6 px — already scaled
      return [pt[0] + OVLP_DX * off, pt[1] + OVLP_DY * off];
    });
  } else {
    mapped = flatMapped;
  }

  // ── Bar rendering: single connected polyline ─────────────────────
  let shadowsHtml, segsHtml, activeGlowHtml;
  {
    const pts3  = mapped.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const pts3s = mapped.map(([x,y]) =>
      `${(x+barW*0.35).toFixed(1)},${(y+barW*0.35).toFixed(1)}`).join(' ');
    shadowsHtml = `<polyline points="${pts3s}" stroke="rgba(0,0,0,0.18)"
      stroke-width="${(barW*1.4).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`;
    segsHtml  = `<polyline points="${pts3}" stroke="${BAR_COLOR}"
      stroke-width="${barW}" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`;
    segsHtml += `<polyline points="${pts3}" stroke="rgba(255,255,255,0.38)"
      stroke-width="${(barW*0.28).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`;
    if (activeSeg >= 0 && activeSeg < mapped.length - 1) {
      const [ax1,ay1] = mapped[activeSeg], [ax2,ay2] = mapped[activeSeg+1];
      const ad = `M ${ax1.toFixed(1)},${ay1.toFixed(1)} L ${ax2.toFixed(1)},${ay2.toFixed(1)}`;
      activeGlowHtml = '';
      segsHtml += `<path d="${ad}" stroke="#2979ff" stroke-width="${barW}" stroke-linecap="round" fill="none"/>`;
      segsHtml += `<path d="${ad}" stroke="rgba(255,255,255,0.55)"
        stroke-width="${(barW*0.28).toFixed(1)}" stroke-linecap="round" fill="none"/>`;
    } else { activeGlowHtml = ''; }
  }

  // ── Bend angle labels ─────────────────────────────────────────
  let bendLabels = '';
  if (showBends) {
    for (let i = 1; i < mapped.length - 1; i++) {
      const [bx, by] = mapped[i];
      const angle = angles[i - 1];
      if (angle !== undefined && angle !== 180) {
        bendLabels += `
          <g opacity="0.92">
          <rect x="${(bx - 16).toFixed(1)}" y="${(by - barW/2 - 24).toFixed(1)}" width="32" height="20" rx="6"
            fill="#ffffff" stroke="#d47a35" stroke-width="1.2" data-ang-click="${i-1}" style="cursor:pointer"/>
          <text x="${bx.toFixed(1)}" y="${(by - barW/2 - 10).toFixed(1)}" text-anchor="middle" font-size="10"
            font-family="Heebo,Arial" font-weight="800" fill="#c9621a"
            data-ang-click="${i-1}" style="cursor:pointer">${angle}°</text>`;
          bendLabels += `</g>`;
      }
    }
  }

  // ── Segment length labels ─────────────────────────────────────
  let dimLabels = '';
  if (showDims) {
    for (let i = 0; i < mapped.length - 1; i++) {
      const [x1, y1] = mapped[i], [x2, y2] = mapped[i + 1];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len * (compactLabels ? 15 : 22), ny = dx / len * (compactLabels ? 15 : 22);
      const isActSeg = i === activeSeg;
      const badgeCol = isActSeg ? '#2979ff' : '#526070';
      const labelValue = formatLengthCmFromMm(sides[i]);
      const labelW = dimensionTagWidth(labelValue, 54, 82);
      dimLabels += `
        <g data-seg-click="${i}" style="cursor:pointer">
          <rect x="${(mx + nx - labelW / 2).toFixed(1)}" y="${(my + ny - 10).toFixed(1)}" width="${labelW}" height="22"
            rx="6" fill="${dark ? 'rgba(26,38,55,0.9)' : 'rgba(255,255,255,0.96)'}" stroke="${badgeCol}" stroke-width="${isActSeg ? 1.8 : 1}"/>
          <text x="${(mx + nx).toFixed(1)}" y="${(my + ny + 5).toFixed(1)}" text-anchor="middle"
            font-size="10" font-family="Heebo,Arial" font-weight="800" fill="${labelClr}">${labelValue}</text>
        </g>`;
    }
  }

  // ── XYZ Axis indicator (bottom-right corner) ──────────────────
  let axisHTML = '';
  if (showAxes) {
    const ax = w - 34, ay = h - 18;
    const axLen = 18;
    // Project world X/Y/Z axes through the current camera
    const xEnd = [ax + axLen * cosT,              ay + axLen * sinT * sinP];
    const yEnd = [ax - axLen * sinT,              ay + axLen * cosT * sinP];
    const zEnd = [ax,                             ay - axLen * cosP];

    axisHTML = `
      <!-- XYZ Axes -->
      <line x1="${ax}" y1="${ay}" x2="${xEnd[0].toFixed(1)}" y2="${xEnd[1].toFixed(1)}"
        stroke="#e05050" stroke-width="2" stroke-linecap="round"/>
      <text x="${(xEnd[0]+4).toFixed(1)}" y="${(xEnd[1]+4).toFixed(1)}"
        font-size="8" font-family="Heebo,Arial" font-weight="800" fill="#e05050">X</text>
      <line x1="${ax}" y1="${ay}" x2="${yEnd[0].toFixed(1)}" y2="${yEnd[1].toFixed(1)}"
        stroke="#22b844" stroke-width="2" stroke-linecap="round"/>
      <text x="${(yEnd[0]-12).toFixed(1)}" y="${(yEnd[1]+4).toFixed(1)}"
        font-size="8" font-family="Heebo,Arial" font-weight="800" fill="#22b844">Y</text>
      <line x1="${ax}" y1="${ay}" x2="${zEnd[0].toFixed(1)}" y2="${zEnd[1].toFixed(1)}"
        stroke="#3a7bd5" stroke-width="2" stroke-linecap="round"/>
      <text x="${(zEnd[0]+3).toFixed(1)}" y="${(zEnd[1]-4).toFixed(1)}"
        font-size="8" font-family="Heebo,Arial" font-weight="800" fill="#3a7bd5">Z</text>
      <circle cx="${ax}" cy="${ay}" r="3" fill="${mutedClr}"/>`;
  }

  const dragHint = opts.dragHint === true && opts.camTheta != null
    ? `<text x="${(w/2).toFixed(0)}" y="${h - 4}" text-anchor="middle"
        font-size="9" font-family="Heebo,Arial" fill="rgba(255,255,255,0.22)">גרור לסובב 🖱</text>`
    : '';

  // Joints: only needed in overlap case (polyline already looks continuous otherwise)
  const jointsHtml = hasOverlap ? mapped.slice(1, -1).map(([x, y], idx) => {
    const isAct = idx === activeSeg || (idx + 1) === activeSeg;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(barW/2).toFixed(1)}"
      fill="${isAct ? '#2979ff' : BAR_COLOR}"/>`;
  }).join('') : '';

  return `
    <!-- ground shadows per segment -->
    ${shadowsHtml}
    <!-- active segment glow -->
    ${activeGlowHtml}
    <!-- segments with per-segment color -->
    ${segsHtml}
    <!-- bend joints -->
    ${jointsHtml}
    <!-- start dot -->
    <circle cx="${mapped[0][0].toFixed(1)}" cy="${mapped[0][1].toFixed(1)}"
      r="${(barW/2).toFixed(1)}" fill="#1a7a42" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>
    <!-- end dot -->
    <circle cx="${mapped[mapped.length-1][0].toFixed(1)}" cy="${mapped[mapped.length-1][1].toFixed(1)}"
      r="${(barW/2).toFixed(1)}" fill="#1560a8" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>
    ${dimLabels}
    ${bendLabels}
    ${axisHTML}
    ${dragHint}
  `;
}

// ── SAVED SHAPES (localStorage) ──────────────────────────────────
// Shape engines keep each product family on its own data contract.
const PILE_BEND_ORIENTATION_DEFAULT_KEY = 'ironbend_pile_bend_orientation_deg_v1';

function normalizePileBendOrientationDeg(value, fallback = 0) {
  const raw = String(value ?? '').trim().replace(/°/g, '').replace(',', '.');
  const numeric = raw === '' ? Number(fallback) : Number(raw);
  if (!Number.isFinite(numeric)) return null;
  const normalized = ((numeric % 360) + 360) % 360;
  return Math.round(normalized * 1000) / 1000;
}

function loadPileBendOrientationDefault() {
  try {
    return normalizePileBendOrientationDeg(localStorage.getItem(PILE_BEND_ORIENTATION_DEFAULT_KEY), 0) ?? 0;
  } catch (_) {
    return 0;
  }
}

function savePileBendOrientationDefault(value) {
  const normalized = normalizePileBendOrientationDeg(value, 0);
  if (normalized === null) return false;
  try { localStorage.setItem(PILE_BEND_ORIENTATION_DEFAULT_KEY, String(normalized)); } catch (_) {}
  return true;
}

function svgEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function scaleBox(widthMm, heightMm, w, h, padding = 24) {
  const safeW = Math.max(1, Number(widthMm) || 1);
  const safeH = Math.max(1, Number(heightMm) || 1);
  const scale = Math.min((w - padding * 2) / safeW, (h - padding * 2) / safeH);
  const drawW = safeW * scale;
  const drawH = safeH * scale;
  return { scale, x: padding + ((w - padding * 2) - drawW) / 2, y: padding + ((h - padding * 2) - drawH) / 2, drawW, drawH };
}

function PolylineBarEngine() {}
PolylineBarEngine.render = function(shape, w = 300, h = 260, opts = {}) {
  const sides = Array.isArray(shape?.sides) ? shape.sides.map(Number) : [];
  const angles = Array.isArray(shape?.angles) ? shape.angles.map(Number) : [];
  if (!sides.length) return '<text x="50%" y="50%" text-anchor="middle" fill="#7a93ab" font-size="12">אין צורה</text>';
  if (opts.view === '3d') return shape3DSVG(sides, angles, w, h, opts.diameter || 12, opts);
  const { path, pts } = shapeSVGPath(sides, angles, w, h, opts.padding || 24);
  const labelHtml = pts.slice(0, -1).map((p, i) => {
    const next = pts[i + 1];
    const mx = (p[0] + next[0]) / 2;
    const my = (p[1] + next[1]) / 2;
    return `<text x="${mx.toFixed(1)}" y="${(my - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#1a2533">${svgEscape(formatLengthCmFromMm(sides[i]))}</text>`;
  }).join('');
  const bends = pts.slice(1, -1).map((p, i) => {
    const angle = angles[i];
    if (angle == null || angle === 180) return '';
    return `<text x="${p[0].toFixed(1)}" y="${(p[1] + 18).toFixed(1)}" text-anchor="middle" font-size="10" font-family="Heebo,Arial" font-weight="800" fill="#c9621a">${svgEscape(angle)}°</text>`;
  }).join('');
  return `<g data-engine="PolylineBarEngine" data-family="bars"><path d="${path}" fill="none" stroke="#3d5e78" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>${labelHtml}${bends}</g>`;
};

function MeshEngine() {}
MeshEngine.render = function(mesh, w = 300, h = 260) {
  const length = Math.max(1, Number(mesh?.length || 600));
  const width = Math.max(1, Number(mesh?.width || 250));
  const longDia = Math.max(1, Number(mesh?.longitudinalDiameter || 8));
  const longSpacing = Math.max(1, Number(mesh?.longitudinalSpacing || 20));
  const transDia = Math.max(1, Number(mesh?.transverseDiameter || 8));
  const transSpacing = Math.max(1, Number(mesh?.transverseSpacing || 20));
  const edgeLeft = Math.max(0, Number(mesh?.edgeLeft || 0));
  const edgeRight = Math.max(0, Number(mesh?.edgeRight || 0));
  const edgeTop = Math.max(0, Number(mesh?.edgeTop || 0));
  const edgeBottom = Math.max(0, Number(mesh?.edgeBottom || 0));
  const box = scaleBox(length, width, w, h, 28);
  const x0 = box.x, y0 = box.y, x1 = box.x + box.drawW, y1 = box.y + box.drawH;
  const innerLeft = Math.min(length, edgeLeft);
  const innerRight = Math.max(innerLeft, length - Math.min(length, edgeRight));
  const innerTop = Math.min(width, edgeTop);
  const innerBottom = Math.max(innerTop, width - Math.min(width, edgeBottom));
  const verticalPositions = [];
  for (let x = innerLeft; x <= innerRight + 0.001; x += longSpacing) verticalPositions.push(Math.min(innerRight, x));
  if (!verticalPositions.length || verticalPositions[verticalPositions.length - 1] !== innerRight) verticalPositions.push(innerRight);
  const horizontalPositions = [];
  for (let y = innerTop; y <= innerBottom + 0.001; y += transSpacing) horizontalPositions.push(Math.min(innerBottom, y));
  if (!horizontalPositions.length || horizontalPositions[horizontalPositions.length - 1] !== innerBottom) horizontalPositions.push(innerBottom);
  const verticals = verticalPositions.map(mm => {
    const x = x0 + mm * box.scale;
    return `<line class="mesh-longitudinal-bar" data-se-focus="mesh-longitudinal-bars mesh-longitudinal-diameter mesh-longitudinal-spacing" x1="${x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#111827" stroke-width="${Math.max(2, longDia * 0.22).toFixed(1)}" stroke-linecap="round"/>`;
  }).join('');
  const horizontals = horizontalPositions.map(mm => {
    const y = y0 + mm * box.scale;
    return `<line class="mesh-transverse-bar" data-se-focus="mesh-transverse-bars mesh-transverse-diameter mesh-transverse-spacing" x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#111827" stroke-width="${Math.max(2, transDia * 0.22).toFixed(1)}" stroke-linecap="round"/>`;
  }).join('');
  const longitudinalSpec = `Ø${longDia}@${formatLengthCm(longSpacing)}`;
  const transverseSpec = `Ø${transDia}@${formatLengthCm(transSpacing)}`;
  const spacingHelperPath = `M ${(x1 - 61).toFixed(1)} ${(y1 + 18).toFixed(1)} H ${(x1 - 20).toFixed(1)}
    M ${(x1 - 61).toFixed(1)} ${(y1 + 28).toFixed(1)} H ${(x1 - 20).toFixed(1)}
    M ${(x1 - 50).toFixed(1)} ${(y1 + 13).toFixed(1)} V ${(y1 + 34).toFixed(1)}
    M ${(x1 - 34).toFixed(1)} ${(y1 + 13).toFixed(1)} V ${(y1 + 34).toFixed(1)}`;
  return `<g data-engine="MeshEngine" data-family="mesh" data-length="${length}" data-width="${width}"
      data-longitudinal="${longitudinalSpec}" data-transverse="${transverseSpec}"
      data-longitudinal-count="${verticalPositions.length}" data-transverse-count="${horizontalPositions.length}"
      data-edge-left="${edgeLeft}" data-edge-right="${edgeRight}" data-edge-top="${edgeTop}" data-edge-bottom="${edgeBottom}">
    <rect data-se-focus="mesh-length mesh-width mesh-edge" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${box.drawW.toFixed(1)}" height="${box.drawH.toFixed(1)}" fill="#fff" stroke="#d8dde5"/>
    ${horizontals}${verticals}
    <text data-se-focus="mesh-length" x="${((x0 + x1) / 2).toFixed(1)}" y="${(y0 - 10).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#1a2533">L ${formatLengthCm(length)}</text>
    <text data-se-focus="mesh-width" x="${(x0 - 10).toFixed(1)}" y="${((y0 + y1) / 2).toFixed(1)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#1a2533" transform="rotate(-90 ${(x0 - 10).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)})">W ${formatLengthCm(width)}</text>
    <g class="se-engineer-helper" data-se-focus="mesh-longitudinal-spacing mesh-transverse-spacing">
      <rect class="se-helper-panel" x="${(x1 - 72).toFixed(1)}" y="${(y1 + 8).toFixed(1)}" width="64" height="34" rx="4"/>
      <path d="${spacingHelperPath}" stroke="#475569" stroke-width="1.5" fill="none"/>
      <text x="${(x1 - 40).toFixed(1)}" y="${(y1 + 53).toFixed(1)}" text-anchor="middle" font-size="8">פרט מרווח</text>
    </g>
    <text data-se-focus="mesh-longitudinal-diameter mesh-longitudinal-spacing mesh-transverse-diameter mesh-transverse-spacing" x="${(x1 + 8).toFixed(1)}" y="${(y1 + 16).toFixed(1)}" font-size="10" font-family="Heebo,Arial" font-weight="800" fill="#526070">${longitudinalSpec} / ${transverseSpec}</text>
  </g>`;
};

function PileCageEngine() {}

function pileCmToMm(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n * 10;
}
function pileZonesCmToMm(zones, fallbackPitchCm = 20) {
  return (Array.isArray(zones) ? zones : []).map((zone, index) => ({
    ...zone,
    name: zone?.name || `Zone ${String.fromCharCode(65 + index)}`,
    length: pileCmToMm(zone?.length, 0),
    pitch: Math.max(1, pileCmToMm(zone?.pitch, pileCmToMm(fallbackPitchCm, 200))),
  }));
}
function normalizePileZones(zones, pileLengthMm = 0) {
  const list = Array.isArray(zones) ? zones : [];
  let usedMm = 0;
  return list.map((zone, index) => {
    const length = Math.max(0, Number(zone?.length || zone?.lengthMm || 0));
    const available = pileLengthMm > 0 ? Math.max(0, pileLengthMm - usedMm) : length;
    const normalizedLength = Math.min(length, available);
    const normalized = {
      index: index + 1,
      zoneIndex: index + 1,
      name: String(zone?.name || `Zone ${String.fromCharCode(65 + index)}`),
      length: normalizedLength,
      pitch: Math.max(1, Number(zone?.pitch || zone?.pitchMm || 200)),
      noWrap: zone?.noWrap === true || zone?.noWrap === 1 || zone?.noWrap === 'true',
    };
    usedMm += normalizedLength;
    return normalized;
  });
}
function pileRound(value, digits = 3) {
  const p = 10 ** digits;
  return Math.round((Number(value) || 0) * p) / p;
}

function pileFieldAllowsZero(key) {
  return new Set(['hoopQuantity', 'hoopStart', 'hoopEnd', 'lHookLength', 'bendOrientationDeg']).has(key);
}

function localizePileValidationError(error) {
  const errorText = String(error || '');
  const hoopPosition = errorText.match(/^reinforcing hoop position P(\d+) at ([\d.-]+) cm is outside cage length ([\d.-]+) cm$/);
  if (hoopPosition) return `טבעת P${hoopPosition[1]} במיקום ${hoopPosition[2]} ס״מ נמצאת מחוץ לאורך הכלוב ${hoopPosition[3]} ס״מ`;
  const validationMap = [
    [/every wrapped spiral segment requires an explicit pitch/, 'חסרה פסיעה במקטע עם כריכות'],
    [/hoopQuantity must be explicitly provided/, 'יש להזין כמות טבעות (אפשר 0)'],
    [/hoopQuantity must be zero or positive/, 'כמות טבעות אינה יכולה להיות שלילית'],
    [/straightBarCount must be greater than 0/, 'יש להזין כמות מוטות ישרים'],
    [/bentBarCount must be greater than 0/, 'יש להזין כמות מוטות מכופפים'],
    [/pileDiameter must be explicitly greater than 0/, 'יש להזין קוטר כלוב'],
    [/pileLength must be explicitly greater than 0/, 'יש להזין אורך כלוב'],
  ];
  return validationMap.find(([pattern]) => pattern.test(errorText))?.[1] || errorText;
}

function canonicalSteelRebarShapes() {
  const api = globalThis.IronBendSteelRebarShapes;
  if (!api) throw new Error('canonical_steel_rebar_shapes_unavailable');
  return api;
}

function pileInternalHoopDiameterMm(pile) {
  const pileDiameter = Math.max(1, Number(pile?.pileDiameter || 0));
  const cover = Math.max(0, Number(pile?.concreteCover || 0));
  const spiralDia = Math.max(0, Number(pile?.spiralDiameter || 0));
  const longDia = Math.max(1, Number(pile?.longitudinalDiameter || 0));
  return Math.max(1, pileDiameter - cover * 2 - spiralDia * 2 - longDia * 2);
}

function pileHoopShapeSides(shape) {
  const normalized = String(shape || 'round').toLowerCase();
  if (normalized === 'hex' || normalized === 'hexagon' || normalized === 'משושה') return 6;
  if (normalized === 'oct' || normalized === 'octagon' || normalized === 'מתומן') return 8;
  return 0;
}

function pileHoopCutLengthMm(diameterMm, shape) {
  const sides = pileHoopShapeSides(shape);
  if (sides > 2) return sides * diameterMm * Math.sin(Math.PI / sides);
  return Math.PI * diameterMm;
}

function pileLongitudinalSpacingMm(diameterMm, barCount, barDiameterMm) {
  const count = Math.max(0, Math.round(Number(barCount) || 0));
  const centerToCenterMm = count > 1 ? diameterMm * Math.sin(Math.PI / count) : 0;
  return {
    centerToCenterMm: pileRound(centerToCenterMm, 1),
    clearMm: pileRound(Math.max(0, centerToCenterMm - Number(barDiameterMm || 0)), 1),
  };
}
function pileHoopPositionsMm({ enabled = true, pileLength = 0, start = 0, end = pileLength, spacing = 1, side = 'start' } = {}) {
  if (!enabled) return [];
  const length = Math.max(0, Number(pileLength || 0));
  const from = Math.min(length, Math.max(0, Number(start || 0)));
  const to = Math.min(length, Math.max(from, Number(end ?? length)));
  const gap = Math.max(1, Number(spacing || 1));
  const positions = [];
  if (String(side || 'start') === 'end') {
    for (let pos = to; pos >= from - 0.001; pos -= gap) positions.push(pileRound(pos, 1));
    return positions.sort((a, b) => a - b);
  }
  for (let pos = from; pos <= to + 0.001; pos += gap) positions.push(pileRound(pos, 1));
  return positions;
}

function normalizePileBarOverrides(overrides, totalBars = 0) {
  if (!Array.isArray(overrides)) return [];
  const maxBar = Math.max(0, Math.round(Number(totalBars) || 0));
  const byIndex = new Map();
  overrides.forEach((entry) => {
    const barIndex = Math.max(1, Math.round(Number(entry?.barIndex || entry?.index || 1)));
    if (maxBar && barIndex > maxBar) return;
    byIndex.set(barIndex, {
      barIndex,
      diameter: Math.max(1, Math.round(Number(entry?.diameter || entry?.diameterMm || 0) || 1)),
      barPattern: String(entry?.barPattern || entry?.type || 'straight').toLowerCase() === 'l' ? 'l' : 'straight',
      lHookLength: Math.max(0, Math.round(Number(entry?.lHookLength || entry?.bendLength || 0) || 0)),
    });
  });
  return Array.from(byIndex.values()).sort((a, b) => a.barIndex - b.barIndex);
}

function calculateRoundPileCage(shape = {}) {
  const hasPositiveInput = value => value !== '' && value !== null && value !== undefined
    && Number.isFinite(Number(value)) && Number(value) > 0;
  const mm = (value, fallback) => Math.max(1, Number(value ?? fallback) * 10);
  const canonical = canonicalSteelRebarShapes();
  const pileDiameterMm = mm(shape.pileDiameter, 60); const pileLengthMm = mm(shape.pileLength, 1200);
  const barDiameterMm = Math.max(1, Number(shape.longitudinalDiameter || 20));
  const straightCount = Math.max(0, Math.round(Number(shape.straightBarCount ?? 0))); const bentCount = Math.max(0, Math.round(Number(shape.bentBarCount ?? 0))); const barCount = straightCount + bentCount;
  const straightLengthMm = mm(shape.straightBarLength, pileLengthMm / 10); const bentLengthMm = mm(shape.bentBarLength, pileLengthMm / 10 + 20); const bendLengthMm = Math.max(0, Number(shape.bendLength ?? 20) * 10);
  const bendOrientationDeg = normalizePileBendOrientationDeg(shape.bendOrientationDeg, 0) ?? 0;
  const spiralBarDiameterMm = Math.max(1, Number(shape.spiralDiameter || 8)); const spiralOuterDiameterMm = mm(shape.spiralOuterDiameter, 48); const spiralCenterlineDiameterMm = spiralOuterDiameterMm - spiralBarDiameterMm;
  // Keep the legacy segment contract deliberately small.  The row order is the
  // physical order on the cage; no start/end coordinates or segment types are
  // saved.  A no-wrap segment has neither turns nor steel.
  const sourceZones = Array.isArray(shape.spiralZones) ? shape.spiralZones : [];
  const normalizedZones = normalizePileZones(
    pileZonesCmToMm(sourceZones, shape.spiralPitch || 15),
    pileLengthMm,
  ).map((zone, index) => ({
    ...zone,
    pitch: sourceZones[index]?.noWrap ? null : (hasPositiveInput(sourceZones[index]?.pitch) ? Number(sourceZones[index].pitch) * 10 : 0),
  }));
  let zoneCursorMm = 0;
  const spiralZones = normalizedZones.map((zone, index) => {
    const startMm = zoneCursorMm;
    zoneCursorMm += zone.length;
    const noWrap = zone.noWrap === true;
    const pitchMm = noWrap ? null : Math.max(0, Number(zone.pitch || 0));
    const helix = noWrap || !(pitchMm > 0) ? null : canonical.calculateHelicalSpiral({
      axialLengthMm: zone.length,
      pitchMm,
      effectiveDiameterMm: spiralCenterlineDiameterMm,
      barDiameterMm: spiralBarDiameterMm,
    });
    return {
      name: String(zone.name || String.fromCharCode(65 + index)),
      lengthMm: zone.length,
      axialLengthMm: zone.length,
      pitchMm,
      noWrap,
      startMm,
      endMm: zoneCursorMm,
      turns: helix?.turns || 0,
      turnsRaw: helix?.turnsRaw || 0,
      helixPerTurnMm: helix?.helicalLengthPerTurnMm || 0,
      totalLengthMm: helix?.helicalCutLengthMm || 0,
      helicalCutLengthMm: helix?.helicalCutLengthMm || 0,
      weightKg: helix?.barWeightKg || 0,
      calculation: helix?.calculation || null,
    };
  });
  const activeSpiralZones = spiralZones.filter(zone => !zone.noWrap && zone.lengthMm > 0);
  const totalSpiralLengthMm = pileRound(activeSpiralZones.reduce((sum, zone) => sum + zone.totalLengthMm, 0), 1);
  const hasHoopQuantity = shape.hoopQuantity !== undefined && shape.hoopQuantity !== null && shape.hoopQuantity !== '';
  const hoopBarDiameterMm = Math.max(1, Number(shape.hoopDiameter || 18)); const hoopBendingDiameterMm = mm(shape.hoopOuterDiameter, 42); const hoopQuantity = hasHoopQuantity ? Math.max(0, Math.round(Number(shape.hoopQuantity))) : 0; const firstHoopOffsetMm = Number(shape.hoopStart ?? 150) * 10; const hoopSpacingMm = Math.max(1, Number(shape.hoopSpacing ?? 30) * 10); const hoopPositionsMm = Array.from({ length: hoopQuantity }, (_, index) => firstHoopOffsetMm + index * hoopSpacingMm);
  const straightContract = canonical.buildBarsShapeContract({ sides: [straightLengthMm], angles: [], diameter: barDiameterMm, shapeType: 'straight_bar' }, { quantity: straightCount });
  const bentMainLengthMm = Math.max(0, bentLengthMm - bendLengthMm);
  const bentContract = canonical.buildBarsShapeContract({ sides: [bentMainLengthMm, bendLengthMm], angles: [90], diameter: barDiameterMm, shapeType: 'l_bar' }, { quantity: bentCount });
  const ringContract = canonical.buildRingShapeContract({ barDiameterMm: hoopBarDiameterMm, bendingDiameterMm: hoopBendingDiameterMm, quantity: Math.max(1, hoopQuantity) });
  const bars = [];
  let straightRemaining = straightCount;
  let bentRemaining = bentCount;
  while (straightRemaining > 0 || bentRemaining > 0) {
    if (straightRemaining > 0) { bars.push({ type: 'straight', lengthMm: straightLengthMm, bendLengthMm: 0 }); straightRemaining -= 1; }
    if (bentRemaining > 0) { bars.push({ type: 'L', lengthMm: bentLengthMm, mainLengthMm: bentMainLengthMm, bendLengthMm, bendOrientationDeg }); bentRemaining -= 1; }
  }
  bars.forEach((bar, index) => Object.assign(bar, { barIndex: index + 1, positionAngleDeg: Number((index * 360 / Math.max(1, barCount)).toFixed(3)), diameterMm: barDiameterMm }));
  const straight = { componentType: 'longitudinal_straight_bar', sourceSystem: 'longitudinalBars', description: 'מוטות אורך ישרים', diameterMm: barDiameterMm, quantity: straightCount, unitLengthMm: straightContract.component.unitLengthMm, totalLengthMm: straightContract.component.totalLengthMm, unitWeightKg: straightContract.component.unitWeightKg, weightKg: straightContract.component.weightKg, sides: straightContract.component.sides, angles: straightContract.component.angles, segments: straightContract.component.segments, canonicalContract: straightContract };
  const bent = { componentType: 'longitudinal_l_bar', sourceSystem: 'longitudinalBars', description: 'מוטות אורך עם כיפוף עליון', diameterMm: barDiameterMm, quantity: bentCount, unitLengthMm: bentContract.component.unitLengthMm, totalLengthMm: bentContract.component.totalLengthMm, unitWeightKg: bentContract.component.unitWeightKg, weightKg: bentContract.component.weightKg, bendLengthMm, sides: bentContract.component.sides, angles: bentContract.component.angles, segments: bentContract.component.segments, canonicalContract: bentContract };
  const spiral = { componentType: 'spiral_consolidated', sourceSystem: 'spiral', description: 'ספירלה מאוחדת', diameterMm: spiralBarDiameterMm, outerDiameterMm: spiralOuterDiameterMm, centerlineDiameterMm: spiralCenterlineDiameterMm, quantity: 1, unitLengthMm: totalSpiralLengthMm, totalLengthMm: totalSpiralLengthMm, weightKg: pileRound(activeSpiralZones.reduce((sum, zone) => sum + zone.weightKg, 0), 3), schedule: spiralZones };
  const hoops = { componentType: 'hoop_ring', sourceSystem: 'hoops', description: 'טבעות חיזוק', diameterMm: hoopBarDiameterMm, hoopOuterDiameterMm: hoopBendingDiameterMm, hoopDiameterMm: hoopBendingDiameterMm, bendingDiameterMm: hoopBendingDiameterMm, quantity: hoopQuantity, spacingMm: hoopSpacingMm, positionsMm: hoopPositionsMm, unitLengthMm: ringContract.component.unitLengthMm, totalLengthMm: hoopQuantity > 0 ? ringContract.component.totalLengthMm : 0, unitWeightKg: ringContract.component.unitWeightKg, weightKg: hoopQuantity > 0 ? ringContract.component.weightKg : 0, canonicalContract: ringContract };
  const candidateBreakdown = [straight, bent, spiral, ...(hoopQuantity > 0 ? [hoops] : [])]; const candidateLongitudinalLengthMm = straight.totalLengthMm + bent.totalLengthMm; const candidateTotalLengthMm = candidateLongitudinalLengthMm + totalSpiralLengthMm + hoops.totalLengthMm; const candidateWeightKg = pileRound(candidateBreakdown.reduce((sum, part) => sum + part.weightKg, 0), 3);
  const firstSpiral = activeSpiralZones[0] || {};
  const barSpacingDisplayMode = String(shape.barSpacingDisplayMode || 'center') === 'clear' ? 'clear' : 'center';
  const data = { pileDiameter: pileDiameterMm, pileLength: pileLengthMm, roundPileCage: true, longitudinalBars: barCount, longitudinalDiameter: barDiameterMm, barSpacingDisplayMode, bendOrientationDeg, bendOrientationReference: 'radial_inward', bendOrientationPositive: 'clockwise', alternatingLayout: true, bars, spiralZones: spiralZones.map(zone => ({ name: zone.name, length: zone.lengthMm, lengthMm: zone.lengthMm, pitch: zone.pitchMm, pitchMm: zone.pitchMm, noWrap: zone.noWrap })), spiral: { continuous: activeSpiralZones.length === 1 && spiralZones.length === 1, pitchMode: 'zones', barDiameterMm: spiralBarDiameterMm, outerDiameterMm: spiralOuterDiameterMm, centerlineDiameterMm: spiralCenterlineDiameterMm, pitchMm: firstSpiral.pitchMm || null, turns: firstSpiral.turns || 0, coverageLengthMm: activeSpiralZones.reduce((sum, zone) => sum + zone.lengthMm, 0), helixPerTurnMm: firstSpiral.helixPerTurnMm || 0, zones: spiralZones, schedule: spiralZones }, hoops: { enabled: true, hoopBarDiameterMm, barDiameterMm: hoopBarDiameterMm, outerDiameterMm: hoopBendingDiameterMm, centerlineDiameterMm: hoopBendingDiameterMm, bendingDiameterMm: hoopBendingDiameterMm, quantity: hoopQuantity, spacingMode: 'byQuantity', firstHoopOffsetMm, spacingMm: hoopSpacingMm, positionsMm: hoopPositionsMm } };
  const validationErrors = [];
  if (!hasPositiveInput(shape.pileDiameter)) validationErrors.push('pileDiameter must be explicitly greater than 0');
  if (!hasPositiveInput(shape.pileLength)) validationErrors.push('pileLength must be explicitly greater than 0');
  if (!hasPositiveInput(shape.longitudinalDiameter)) validationErrors.push('longitudinalDiameter must be explicitly greater than 0');
  if (!hasPositiveInput(shape.straightBarLength)) validationErrors.push('straightBarLength must be explicitly greater than 0');
  if (!hasPositiveInput(shape.bentBarLength)) validationErrors.push('bentBarLength must be explicitly greater than 0');
  if (!hasPositiveInput(shape.bendLength)) validationErrors.push('bendLength must be explicitly greater than 0');
  if (!hasPositiveInput(shape.spiralDiameter)) validationErrors.push('spiralDiameter must be explicitly greater than 0');
  if (!hasPositiveInput(shape.spiralOuterDiameter)) validationErrors.push('spiralOuterDiameter must be explicitly greater than 0');
  if (!sourceZones.length) validationErrors.push('spiralZones must be explicitly provided');
  if (sourceZones.some(zone => !zone?.noWrap && !hasPositiveInput(zone?.pitch))) validationErrors.push('every wrapped spiral segment requires an explicit pitch');
  if (hoopQuantity > 0 && !hasPositiveInput(shape.hoopDiameter)) validationErrors.push('hoopDiameter must be explicitly greater than 0');
  if (hoopQuantity > 0 && !hasPositiveInput(shape.hoopOuterDiameter)) validationErrors.push('hoopOuterDiameter must be explicitly greater than 0');
  if (straightCount < 1) validationErrors.push('straightBarCount must be greater than 0');
  if (bentCount < 1) validationErrors.push('bentBarCount must be greater than 0');
  if (barCount < 3) validationErrors.push('longitudinalBars must be at least 3');
  if (!(spiralCenterlineDiameterMm > 0)) validationErrors.push('spiral centerline diameter must be greater than 0');
  if (!activeSpiralZones.length) validationErrors.push('at least one wrapped spiral segment is required');
  if (!hasHoopQuantity) validationErrors.push('hoopQuantity must be explicitly provided');
  if (hasHoopQuantity && Number(shape.hoopQuantity) < 0) validationErrors.push('hoopQuantity must be zero or positive');
  hoopPositionsMm.forEach((positionMm, index) => {
    if (positionMm < 0 || positionMm > pileLengthMm) validationErrors.push(`reinforcing hoop position P${index + 1} at ${pileRound(positionMm / 10, 3)} cm is outside cage length ${pileRound(pileLengthMm / 10, 3)} cm`);
  });
  const validation = { valid: validationErrors.length === 0, errors: validationErrors, warnings: [] };
  const manufacturingBreakdown = validation.valid ? candidateBreakdown : [];
  const totalLongitudinalLengthMm = validation.valid ? candidateLongitudinalLengthMm : 0;
  const safeSpiralLengthMm = validation.valid ? totalSpiralLengthMm : 0;
  const totalHoopLengthMm = validation.valid ? hoops.totalLengthMm : 0;
  const totalLengthMm = validation.valid ? candidateTotalLengthMm : 0;
  const weightKg = validation.valid ? candidateWeightKg : 0;
  const calculated = { totalLongitudinalLengthMm, totalSpiralLengthMm: safeSpiralLengthMm, totalHoopLengthMm, totalLengthMm, weightKg, totalWeightKg: weightKg, manufacturingBreakdown };
  const componentCards = manufacturingBreakdown.map((part, index) => ({ cardType: 'pile_component', componentType: part.componentType, title: part.description, componentIndex: index + 1, quantity: part.quantity, diameterMm: part.diameterMm, unitLengthMm: part.unitLengthMm, totalLengthMm: part.totalLengthMm, weightKg: part.weightKg, source: part, scanCodeSuffix: `C${index + 1}` }));
  const assemblyCard = { cardType: 'pile_assembly', componentType: 'pile_assembly', title: 'PILE CAGE', componentIndex: componentCards.length + 1, quantity: 1, diameterMm: pileDiameterMm, unitLengthMm: pileLengthMm, totalLengthMm: pileLengthMm, totalSteelCutLengthMm: totalLengthMm, weightKg, componentSummary: componentCards.map(card => ({ componentType: card.componentType, quantity: card.quantity, diameterMm: card.diameterMm, unitLengthMm: card.unitLengthMm, totalLengthMm: card.totalLengthMm, weightKg: card.weightKg })), scanCodeSuffix: 'ASSEMBLY' };
  const productionCards = validation.valid ? [...componentCards, assemblyCard] : [];
  const assemblySummary = { identity: 'round_pile_cage', pileDiameterMm, physicalLengthMm: pileLengthMm, quantity: 1, componentCount: componentCards.length, productionCardCount: productionCards.length, totalSteelLengthMm: totalLengthMm, weightKg };
  return { data, calculated, machineOutput: { generic: { family: 'piles', shapeType: 'round_pile_cage', ...data, manufacturingBreakdown, productionCards, assemblySummary }, machineProfiles: {} }, validation, manufacturingBreakdown, productionCards, assemblySummary };
}

PileCageEngine.calculate = function(shape = {}) {
  if (shape?.roundPileCage) return calculateRoundPileCage(shape);
  const pileLengthMm = Math.max(1, pileCmToMm(shape.pileLength || 2200, 22000));
  const pileDiameterMm = Math.max(1, pileCmToMm(shape.pileDiameter || 70, 700));
  const zones = normalizePileZones(
    pileZonesCmToMm(shape.spiralZones, shape.spiralPitch || 20),
    pileLengthMm,
  );
  const data = {
    pileDiameter: pileDiameterMm,
    pileLength: pileLengthMm,
    concreteCover: Math.max(0, pileCmToMm(shape.concreteCover || 0, 0)),
    longitudinalBars: Math.max(0, Math.round(Number(shape.longitudinalBars || 0))),
    longitudinalDiameter: Math.max(1, Number(shape.longitudinalDiameter || 22)),
    spiralDiameter: Math.max(1, Number(shape.spiralDiameter || 8)),
    spiralType: String(shape.spiralType || 'zoned'),
    spiralZones: zones,
    hoopsEnabled: shape.hoopsEnabled !== false && shape.hoopsEnabled !== 0 && shape.hoopsEnabled !== 'false',
    hoopDiameter: Math.max(14, Number(shape.hoopDiameter || 14)),
    hoopSpacing: Math.max(1, pileCmToMm(shape.hoopSpacing || 300, 3000)),
    hoopStart: Math.max(0, pileCmToMm(shape.hoopStart || 0, 0)),
    hoopEnd: Math.max(0, pileCmToMm(shape.hoopEnd || shape.pileLength || 2200, pileLengthMm)),
    hoopStartSide: String(shape.hoopStartSide || 'start') === 'end' ? 'end' : 'start',
    hoopShape: String(shape.hoopShape || 'round'),
    barPattern: String(shape.barPattern || 'straight'),
    lHookLength: Math.max(0, pileCmToMm(shape.lHookLength || 0, 0)),
    longitudinalBarOverrides: [],
  };
  data.longitudinalBarOverrides = normalizePileBarOverrides((shape.longitudinalBarOverrides || []).map(entry => ({
    ...entry,
    lHookLength: pileCmToMm(entry?.lHookLength || entry?.bendLength || 0, 0),
  })), data.longitudinalBars);

  let startMm = 0;
  const machineZones = zones.map(zone => {
    const out = { index: zone.index, zoneIndex: zone.zoneIndex, name: zone.name, startMm, lengthMm: zone.length, pitchMm: zone.pitch, noWrap: zone.noWrap };
    startMm += zone.length;
    return out;
  });
  const wrapZones = machineZones.filter(zone => !zone.noWrap);
  const totalLongitudinalLengthMm = data.pileLength * data.longitudinalBars;
  const totalLongitudinalWeightKg = pileRound((totalLongitudinalLengthMm / 1000) * sharedKgPerMeter(data.longitudinalDiameter));
  const spiralCenterDiameterMm = Math.max(1, data.pileDiameter - data.concreteCover * 2);
  const internalHoopDiameterMm = pileInternalHoopDiameterMm(data);
  const hoopShape = String(data.hoopShape || 'round');
  const hoopCutLengthMm = pileRound(pileHoopCutLengthMm(internalHoopDiameterMm, hoopShape), 1);
  const barSpacing = pileLongitudinalSpacingMm(internalHoopDiameterMm, data.longitudinalBars, data.longitudinalDiameter);
  const totalSpiralLengthMm = wrapZones.reduce((sum, zone) => sum + pileSpiralLengthMm(spiralCenterDiameterMm, zone.lengthMm, zone.pitchMm), 0);
  const totalSpiralWeightKg = pileRound((totalSpiralLengthMm / 1000) * sharedKgPerMeter(data.spiralDiameter));
  const hoopPositions = pileHoopPositionsMm({ enabled: data.hoopsEnabled, pileLength: data.pileLength, start: data.hoopStart, end: data.hoopEnd, spacing: data.hoopSpacing, side: data.hoopStartSide });
  const hoopLengthMm = hoopCutLengthMm;
  const totalHoopLengthMm = pileRound(hoopLengthMm * hoopPositions.length, 1);
  const totalHoopWeightKg = pileRound((totalHoopLengthMm / 1000) * sharedKgPerMeter(data.hoopDiameter));
  const totalLengthMm = pileRound(totalLongitudinalLengthMm + totalSpiralLengthMm + totalHoopLengthMm, 1);
  const weightKg = pileRound(totalLongitudinalWeightKg + totalSpiralWeightKg + totalHoopWeightKg);

  const manufacturingBreakdown = [];
  manufacturingBreakdown.push({ componentType: data.barPattern === 'l' ? 'longitudinal_l_bar' : 'longitudinal_straight_bar', sourceSystem: 'longitudinalBars', description: data.barPattern === 'l' ? 'Longitudinal L bars' : 'Longitudinal straight bars', diameterMm: data.longitudinalDiameter, quantity: data.longitudinalBars, totalLengthMm: totalLongitudinalLengthMm, weightKg: totalLongitudinalWeightKg });
  wrapZones.forEach(zone => {
    const zoneLengthMm = pileSpiralLengthMm(spiralCenterDiameterMm, zone.lengthMm, zone.pitchMm);
    manufacturingBreakdown.push({ componentType: 'spiral_zone', sourceSystem: 'spiral', description: `Spiral zone ${zone.name}`, name: zone.name, zoneIndex: zone.zoneIndex, diameterMm: data.spiralDiameter, pitchMm: zone.pitchMm, quantity: 1, startMm: zone.startMm, zoneLengthMm: zone.lengthMm, totalLengthMm: zoneLengthMm, weightKg: pileRound((zoneLengthMm / 1000) * sharedKgPerMeter(data.spiralDiameter)) });
  });
  if (data.hoopsEnabled) manufacturingBreakdown.push({ componentType: 'hoop_ring', sourceSystem: 'hoops', description: 'Internal reinforcement hoops', diameterMm: data.hoopDiameter, hoopDiameterMm: internalHoopDiameterMm, hoopCutLengthMm, hoopShape, hoopShapeSides: pileHoopShapeSides(hoopShape), barCenterSpacingMm: barSpacing.centerToCenterMm, barClearSpacingMm: barSpacing.clearMm, quantity: hoopPositions.length, positionsMm: hoopPositions, totalLengthMm: totalHoopLengthMm, weightKg: totalHoopWeightKg });

  const productionCards = [{ cardType: 'pile_master', componentType: 'pile_master', title: 'Pile cage 1/1', unitIndex: 1, unitTotal: 1, componentIndex: 0, quantity: 1, totalLengthMm: data.pileLength, diameterMm: data.longitudinalDiameter, scanCodeSuffix: 'P1-MASTER' }]
    .concat(manufacturingBreakdown.map((part, index) => ({ cardType: 'pile_component', componentType: part.componentType, title: part.description, unitIndex: 1, unitTotal: 1, componentIndex: index + 1, quantity: part.quantity || 1, diameterMm: part.diameterMm, totalLengthMm: part.totalLengthMm, weightKg: part.weightKg, source: part, scanCodeSuffix: `P1-C${index + 1}` })));

  const validation = validateShapeContractData('piles', data);
  return {
    data,
    calculated: { totalLongitudinalLengthMm, totalSpiralLengthMm, totalHoopLengthMm, totalLengthMm, weightKg, totalLongitudinalWeightKg, totalSpiralWeightKg, totalHoopWeightKg, spiralCenterDiameterMm, internalHoopDiameterMm, hoopCutLengthMm, barCenterSpacingMm: barSpacing.centerToCenterMm, barClearSpacingMm: barSpacing.clearMm, manufacturingBreakdown },
    machineOutput: { generic: { family: 'piles', shapeType: 'round_pile_cage', ...data, spiralZones: machineZones, spiralCenterDiameterMm, internalHoopDiameterMm, hoopCutLengthMm, barCenterSpacingMm: barSpacing.centerToCenterMm, barClearSpacingMm: barSpacing.clearMm, totalLongitudinalLengthMm, totalSpiralLengthMm, totalHoopLengthMm, totalLengthMm, manufacturingBreakdown, productionCards }, machineProfiles: {} },
    validation,
    manufacturingBreakdown,
    productionCards,
  };
};

PileCageEngine.render = function(pile, w = 300, h = 260) {
  const pileDiameterCm = Math.max(1, Number(pile?.pileDiameter || 70));
  const pileLengthCm = Math.max(1, Number(pile?.pileLength || 2200));
  const pileDiameter = pileCmToMm(pileDiameterCm, 700);
  const pileLength = pileCmToMm(pileLengthCm, 22000);
  const longitudinalBars = Math.max(0, Math.round(Number(pile?.longitudinalBars || 0)));
  const longitudinalDiameter = Math.max(1, Number(pile?.longitudinalDiameter || 22));
  const spiralDiameter = Math.max(1, Number(pile?.spiralDiameter || 8));
  const hoopsEnabled = pile?.hoopsEnabled !== false && pile?.hoopsEnabled !== 0 && pile?.hoopsEnabled !== 'false';
  const hoopDiameter = Math.max(1, Number(pile?.hoopDiameter || 14));
  const hoopSpacing = Math.max(1, pileCmToMm(pile?.hoopSpacing || 300, 3000));
  const hoopStart = Math.max(0, pileCmToMm(pile?.hoopStart || 0, 0));
  const hoopEnd = Math.max(hoopStart, pileCmToMm(pile?.hoopEnd || pileLengthCm, pileLength));
  const hoopStartSide = String(pile?.hoopStartSide || 'start') === 'end' ? 'end' : 'start';
  const concreteCover = Math.max(0, pileCmToMm(pile?.concreteCover || 0, 0));
  const internalHoopDiameter = pileInternalHoopDiameterMm({ pileDiameter, concreteCover, spiralDiameter, longitudinalDiameter });
  const hoopShape = String(pile?.hoopShape || 'round');
  const barSpacing = pileLongitudinalSpacingMm(internalHoopDiameter, longitudinalBars, longitudinalDiameter);
  const barSpacingDisplayMode = String(pile?.barSpacingDisplayMode || 'center') === 'clear' ? 'clear' : 'center';
  const barPattern = String(pile?.barPattern || 'straight');
  const lHookLength = Math.max(0, pileCmToMm(pile?.lHookLength ?? pile?.bendLength ?? 25, 250));
  const bendOrientationDeg = normalizePileBendOrientationDeg(pile?.bendOrientationDeg, 0) ?? 0;
  const bendOrientationRad = bendOrientationDeg * Math.PI / 180;
  // Bend angle of the bent longitudinal bar head (display only, default 90°).
  const lHookAngle = Math.max(1, Math.min(180, Number(pile?.lHookAngle ?? pile?.bendAngle ?? 90) || 90));
  const zones = Array.isArray(pile?.spiralZones) && pile.spiralZones.length
    ? pileZonesCmToMm(pile.spiralZones, pile?.spiralPitch || 20)
    : [{ name: 'Zone A', length: pileLength, pitch: pileCmToMm(pile?.spiralPitch || 20, 200) }];
  const roundPile = Boolean(pile?.roundPileCage);
  const sideLeft = w * 0.08;
  const sideRight = w * 0.93;
  const sideTop = h * 0.12;
  const sideMid = h * 0.27;
  const cageHeight = Math.max(24, Math.min(h * 0.18, w * 0.14));
  const sideW = Math.max(40, sideRight - sideLeft);
  const scale = sideW / pileLength;
  const topY = sideMid - cageHeight / 2;
  const bottomY = sideMid + cageHeight / 2;
  const overallDimensionY = sideTop - 17;
  const zoneDimensionY = sideTop;
  const hoopLaneY = bottomY + 11;
  const spiralLaneY = bottomY + 29;
  const barStroke = Math.max(2.2, Math.min(5.5, longitudinalDiameter * 0.16));
  const spiralStroke = Math.max(1.1, Math.min(3.2, spiralDiameter * 0.18));
  const hoopStroke = Math.max(1.2, Math.min(3.4, hoopDiameter * 0.14));
  const cx = roundPile ? w * 0.50 : w * 0.30;
  const cy = h * 0.72;
  const r = Math.max(24, Math.min(w * 0.17, h * 0.17));
  const internalHoopRadius = Math.max(4, Math.min(r * 0.96, (internalHoopDiameter / Math.max(1, pileDiameter)) * r));
  const dimColor = '#8b98ab';
  const steelColor = '#1a2332';   // IronBend navy — straight steel
  const auxColor = '#5fa83c';     // IronBend green — spiral guide
  const hoopColor = '#5fa83c';    // IronBend green — reinforcement rings
  const accent = roundPile ? '#e07b39' : '#1d4ed8'; // IronBend orange — bent bars
  const labelBox = (x, y, value, cls = '', rotate = 0, edit = '') => `<g class="pile-label ${cls}"${edit ? ` data-pile-edit="${edit}"` : ''} transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotate})"><rect x="-17" y="-8" width="34" height="16" rx="3" fill="#fff" stroke="#94a3b8" stroke-width=".9"/><text text-anchor="middle" dominant-baseline="central" font-size="9" font-family="Heebo,Arial" font-weight="800" fill="#111827">${svgEscape(value)}</text></g>`;
  const dimLine = (x1, y1, x2, y2, cls = '', focus = '', edit = '') => `<line class="pile-dimension-line ${cls}" data-se-focus="${focus}"${edit ? ` data-pile-edit="${edit}"` : ''} x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${dimColor}" stroke-width="1" marker-start="url(#sePileDimArrow)" marker-end="url(#sePileDimArrow)"/>`;

  // Elevation shows a representative handful of bars (the section carries the
  // true count) so the side view stays legible instead of a dense stack.
  const displayedLongitudinalBars = roundPile ? Math.min(Math.max(1, longitudinalBars), 5) : 2;
  const longitudinalLines = Array.from({ length: displayedLongitudinalBars }, (_, index) => {
    const y = displayedLongitudinalBars === 1
      ? sideMid
      : topY + cageHeight * (0.15 + (index / (displayedLongitudinalBars - 1)) * 0.70);
    const isBent = barPattern === 'l' || (barPattern === 'alternate' && index % 2 === 1);
    if (!isBent) return `<line class="pile-straight-bar" data-pile-bar-type="straight" data-pile-edit="bars|straightBarLength" data-se-focus="pile-longitudinal-bars pile-longitudinal-diameter" x1="${sideLeft.toFixed(1)}" y1="${y.toFixed(1)}" x2="${sideRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#374151" stroke-width="${barStroke.toFixed(1)}" stroke-linecap="square"/>`;
    // Elevation is an uncluttered assembly illustration. Bent and straight
    // longitudinal bars look identical here; the bend group and direction are
    // communicated only by the complete cross-section and the L component card.
    return `<line class="pile-l-bar" data-pile-bar-type="bent" data-pile-edit="bars|bendLength" data-se-focus="pile-l-bars pile-l-hook pile-longitudinal-bars" x1="${sideLeft.toFixed(1)}" y1="${y.toFixed(1)}" x2="${sideRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#374151" stroke-width="${barStroke.toFixed(1)}" stroke-linecap="square"/>`;
  }).join('');

  let offsetMm = 0;
  const zoneDimensions = [];
  const pitchLabels = [];
  const spiralLoops = [];
  const zoneBoundaries = [];
  const noWrapZones = [];
  const visualTurnBudget = Math.max(12, Math.min(24, Math.round(sideW / 24)));
  const maximumDenseTurns = Math.max(1, pileLengthCm / 10);
  zones.forEach((zone, zoneIndex) => {
    const len = Math.max(0, Number(zone.length || 0));
    const pitch = Math.max(1, Number(zone.pitch || 20));
    const startMm = offsetMm;
    const endMm = Math.min(pileLength, offsetMm + len);
    const startX = sideLeft + Math.min(pileLength, startMm) * scale;
    const endX = sideLeft + endMm * scale;
    const midX = (startX + endX) / 2;
    const compactZoneLabel = (endX - startX) < 54;
    const zoneLabelX = compactZoneLabel ? startX + 2 : midX;
    const zoneLabelY = compactZoneLabel ? zoneDimensionY + 11 : zoneDimensionY - 4;
    const zoneLabelAnchor = compactZoneLabel ? 'start' : 'middle';
    const noWrap = zone.noWrap === true || zone.noWrap === 1 || zone.noWrap === 'true';
    const rawZoneName = String(zone?.name || String.fromCharCode(65 + zoneIndex)).trim();
    const zoneName = (rawZoneName.replace(/^Zone\s+/i, '').trim() || String.fromCharCode(65 + zoneIndex)).toUpperCase();
    zoneBoundaries.push(`<line class="pile-zone-boundary" data-zone="${zoneIndex}" data-se-focus="pile-zone" x1="${startX.toFixed(1)}" y1="${(topY - 14).toFixed(1)}" x2="${startX.toFixed(1)}" y2="${(bottomY + 18).toFixed(1)}" stroke="${dimColor}" stroke-width=".9"/>`);
    zoneDimensions.push(`${dimLine(startX, zoneDimensionY, endX, zoneDimensionY, 'pile-zone-dimension', 'pile-zone pile-spiral-pitch', `spiral|zone|${zoneIndex}|length`)}<text class="pile-zone-dimension" data-zone="${zoneIndex}" data-pile-edit="spiral|zone|${zoneIndex}|length" data-se-focus="pile-zone pile-spiral-pitch" x="${zoneLabelX.toFixed(1)}" y="${zoneLabelY.toFixed(1)}" text-anchor="${zoneLabelAnchor}" font-size="8" font-family="Heebo,Arial" font-weight="900" fill="#334155">${svgEscape(zoneName)} · ${displayNumber(len / 10)} ס״מ</text>`);
    if (!noWrap) {
      pitchLabels.push(`<g class="pile-pitch-label" data-zone="${zoneIndex}" data-pile-edit="spiral|zone|${zoneIndex}|pitch" data-se-focus="pile-spiral-pitch pile-zone"><rect x="${(midX - 25).toFixed(1)}" y="${(spiralLaneY - 8).toFixed(1)}" width="50" height="14" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width=".7"/><text x="${midX.toFixed(1)}" y="${(spiralLaneY + 2).toFixed(1)}" text-anchor="middle" font-size="8.5" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">${svgEscape(zoneName)} · @${displayNumber(pitch / 10)} ס״מ</text></g>`);
    }
    if (noWrap) {
      noWrapZones.push(`<rect class="pile-no-wrap-zone" data-zone="${zoneIndex}" data-pile-edit="spiral|zone|${zoneIndex}|noWrap" data-se-focus="pile-no-wrap pile-zone" x="${startX.toFixed(1)}" y="${topY.toFixed(1)}" width="${Math.max(1, endX - startX).toFixed(1)}" height="${cageHeight.toFixed(1)}" fill="rgba(255,255,255,.72)" stroke="#94a3b8" stroke-dasharray="4 4"/><g class="pile-no-wrap-label" data-zone="${zoneIndex}" data-pile-edit="spiral|zone|${zoneIndex}|noWrap" data-se-focus="pile-no-wrap pile-zone" fill="#64748b" font-family="Heebo,Arial" font-size="5.5" font-weight="900" text-anchor="middle" style="paint-order:stroke;stroke:#fff;stroke-width:2px;stroke-linejoin:round"><text x="${midX.toFixed(1)}" y="${(sideMid - 1).toFixed(1)}">ללא</text><text x="${midX.toFixed(1)}" y="${(sideMid + 5).toFixed(1)}">כריכות</text></g>`);
    } else {
      // Representative engineering helix. Every zone is scaled independently
      // against one cage-wide dense-pitch reference. Editing one zone therefore
      // cannot change the illustrated density of a different zone.
      const spTop = sideMid - cageHeight * 0.5;
      const spBottom = sideMid + cageHeight * 0.5;
      const actualTurns = Math.max(1, Math.round((endMm - startMm) / pitch));
      const proportionalTurns = Math.max(1, Math.ceil((actualTurns / maximumDenseTurns) * visualTurnBudget));
      const widthLimit = Math.max(1, Math.floor(Math.max(1, endX - startX) / 6));
      const nLoops = Math.max(1, Math.min(actualTurns, widthLimit, proportionalTurns || 1));
      const step = (endX - startX) / nLoops;
      for (let k = 0; k < nLoops; k++) {
        const xa = startX + step * k;
        const xb = startX + step * (k + 1);
        // Each turn = diagonal up + vertical back, so the coil reads as a
        // connected spiral rather than loose slashes.
        spiralLoops.push(`<path class="pile-spiral-loop" data-zone="${zoneIndex}" data-pile-edit="spiral|zone|${zoneIndex}|pitch" data-se-focus="pile-spiral-pitch pile-spiral-diameter pile-zone" d="M ${xa.toFixed(1)} ${spBottom.toFixed(1)} L ${xb.toFixed(1)} ${spTop.toFixed(1)} L ${xb.toFixed(1)} ${spBottom.toFixed(1)}" fill="none" stroke="${steelColor}" stroke-width="${spiralStroke.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/>`);
      }
    }
    offsetMm += len;
  });
  zoneBoundaries.push(`<line class="pile-zone-boundary" data-se-focus="pile-zone" x1="${sideRight.toFixed(1)}" y1="${(topY - 14).toFixed(1)}" x2="${sideRight.toFixed(1)}" y2="${(bottomY + 18).toFixed(1)}" stroke="${dimColor}" stroke-width=".9"/>`);

  const hoopPositionsForDrawing = (roundPile
    ? Array.from({ length: Math.max(0, Math.round(Number(pile?.hoopQuantity || 0))) }, (_, index) => Number(pile?.hoopStart || 0) * 10 + index * Math.max(1, Number(pile?.hoopSpacing || 0) * 10))
    : pileHoopPositionsMm({ enabled: hoopsEnabled, pileLength, start: hoopStart, end: hoopEnd, spacing: hoopSpacing, side: hoopStartSide })
  );
  const hoopLines = hoopPositionsForDrawing.map((xMm, index) => {
    const x = sideLeft + xMm * scale;
    const showPositionLabel = hoopPositionsForDrawing.length <= 6 || index === 0 || index === hoopPositionsForDrawing.length - 1;
    const positionLabel = showPositionLabel ? `<text class="pile-hoop-label" data-pile-edit="hoops|hoopQuantity" x="${x.toFixed(1)}" y="${hoopLaneY.toFixed(1)}" text-anchor="middle" font-size="6.5" font-family="Arial" font-weight="900" fill="#2f6f25">P${index + 1}</text>` : '';
    return `<g class="pile-hoop-position" data-hoop-index="${index + 1}" data-hoop-position-mm="${xMm}"><line class="pile-hoop" data-pile-edit="hoops|hoopQuantity" data-se-focus="pile-hoops pile-hoop-diameter pile-hoop-spacing" x1="${x.toFixed(1)}" y1="${(topY - 3).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(bottomY + 3).toFixed(1)}" stroke="${hoopColor}" stroke-width="${hoopStroke.toFixed(1)}" opacity=".9"/>${positionLabel}</g>`;
  });
  const hoopPlacementSummary = roundPile && hoopPositionsForDrawing.length > 6
    ? `<text class="pile-hoop-placement-summary" data-pile-edit="hoops|hoopQuantity" data-se-focus="pile-hoops pile-hoop-spacing" x="${sideRight.toFixed(1)}" y="${hoopLaneY.toFixed(1)}" text-anchor="end" font-size="7" font-family="Arial" font-weight="900" fill="#2f6f25">P1…P${hoopPositionsForDrawing.length}</text>`
    : '';

  const topBars = Array.from({ length: longitudinalBars }, (_, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, longitudinalBars);
    const x = cx + Math.cos(a) * r * 0.78;
    const y = cy + Math.sin(a) * r * 0.78;
    const isBent = barPattern === 'l' || (barPattern === 'alternate' && i % 2 === 1);
    const fill = isBent ? accent : '#111827';
    // Orientation is relative to radial-inward. 0° points to the cage centre;
    // positive angles rotate clockwise in this cross-section.
    const hookAngle = a + Math.PI + bendOrientationRad;
    const hookEndX = x + Math.cos(hookAngle) * r * 0.36;
    const hookEndY = y + Math.sin(hookAngle) * r * 0.36;
    const hook = isBent
      ? `<path class="pile-bent-head-hook" data-pile-head-hook="1" data-pile-bend-orientation="${bendOrientationDeg}" data-pile-edit="bars|bendOrientationDeg" data-se-focus="pile-l-bars pile-l-hook pile-longitudinal-bars" d="M ${x.toFixed(1)} ${y.toFixed(1)} L ${hookEndX.toFixed(1)} ${hookEndY.toFixed(1)}" fill="none" stroke="${accent}" stroke-width="${Math.max(2.1, barStroke * 0.58).toFixed(1)}" stroke-linecap="round"/>`
      : '';
    return `${hook}<circle class="pile-longitudinal-bar" data-pile-bar-type="${isBent ? 'bent' : 'straight'}" data-pile-edit="bars|longitudinalDiameter" data-se-focus="pile-longitudinal-bars pile-longitudinal-diameter" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(2.4, Math.min(4.8, longitudinalDiameter * 0.13)).toFixed(1)}" fill="${fill}"/>`;
  }).join('');
  const renderedBarRadius = Math.max(2.4, Math.min(4.8, longitudinalDiameter * 0.13));
  const spacingDimension = (() => {
    if (longitudinalBars < 2) return '';
    const angleA = -Math.PI / 2;
    const angleB = angleA + 2 * Math.PI / longitudinalBars;
    const pointA = { x: cx + Math.cos(angleA) * r * 0.78, y: cy + Math.sin(angleA) * r * 0.78 };
    const pointB = { x: cx + Math.cos(angleB) * r * 0.78, y: cy + Math.sin(angleB) * r * 0.78 };
    const dx = pointB.x - pointA.x;
    const dy = pointB.y - pointA.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const inset = barSpacingDisplayMode === 'clear' ? renderedBarRadius : 0;
    const x1 = pointA.x + ux * inset;
    const y1 = pointA.y + uy * inset;
    const x2 = pointB.x - ux * inset;
    const y2 = pointB.y - uy * inset;
    const label = barSpacingDisplayMode === 'clear'
      ? `CLEAR ${displayNumber(barSpacing.clearMm / 10)} ס״מ`
      : `C/C ${displayNumber(barSpacing.centerToCenterMm / 10)} ס״מ`;
    return `<g class="pile-bar-spacing-dimension" data-spacing-mode="${barSpacingDisplayMode}" data-pile-edit="bars|barSpacingDisplayMode" data-se-focus="pile-bar-spacing"><line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${dimColor}" stroke-width="1" marker-start="url(#sePileDimArrow)" marker-end="url(#sePileDimArrow)"/><text x="${((x1 + x2) / 2 + 3).toFixed(1)}" y="${((y1 + y2) / 2 - 5).toFixed(1)}" text-anchor="middle" font-size="7" font-family="Arial" font-weight="900" fill="#334155">${label}</text></g>`;
  })();
  const topHoop = hoopsEnabled
    ? `<circle class="pile-hoop" data-pile-edit="hoops|hoopOuterDiameter" data-se-focus="pile-hoops pile-hoop-diameter" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${internalHoopRadius.toFixed(1)}" fill="none" stroke="${hoopColor}" stroke-width="${hoopStroke.toFixed(1)}" opacity=".75"/>`
    : '';
  const zoneSummary = zones.map(z => `${Number(z.length || 0)}@${Number(z.pitch || 0)}${(z.noWrap === true || z.noWrap === 1 || z.noWrap === 'true') ? ':no-wrap' : ''}`).join(',');

  const headBent = roundPile && (barPattern === 'l' || barPattern === 'alternate');
  const headLabel = '';
  const bendAngleMarker = '';
  const alternatingLegend = roundPile && barPattern === 'alternate'
    ? `<text data-pile-head="1" data-pile-alternating-legend="1" x="${cx.toFixed(1)}" y="${(cy - r - 14).toFixed(1)}" text-anchor="middle" font-size="7" font-family="Arial" font-weight="900" fill="#334155">● / ↪ · ${svgEscape(bendOrientationDeg)}°</text>`
    : '';
  return `<g data-engine="PileCageEngine" data-family="piles" data-pile-diameter="${pileDiameter}" data-pile-length="${pileLength}" data-input-unit="cm" data-longitudinal-bars="${longitudinalBars}" data-longitudinal-diameter="${longitudinalDiameter}" data-bend-orientation-deg="${bendOrientationDeg}" data-bend-orientation-reference="radial_inward" data-spiral-diameter="${spiralDiameter}" data-spiral-zones="${zoneSummary}" data-hoop-count="${hoopLines.length}" data-internal-hoop-diameter="${internalHoopDiameter}" data-bar-center-spacing="${barSpacing.centerToCenterMm}" data-bar-clear-spacing="${barSpacing.clearMm}" data-bar-spacing-mode="${barSpacingDisplayMode}" data-bar-pattern="${svgEscape(barPattern)}">
    <defs><marker id="sePileDimArrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 4 L 8 0 L 8 8 Z" fill="${dimColor}"/></marker></defs>
    <g data-view="side" class="pile-side-engineering-view">
      <text data-pile-edit="general|pileLength" data-se-focus="pile-length" x="${(w / 2).toFixed(1)}" y="${(overallDimensionY - 5).toFixed(1)}" text-anchor="middle" font-size="13" font-family="Heebo,Arial" font-weight="900" fill="#111827">L ${pileLengthCm} ס״מ</text>
      ${dimLine(sideLeft, overallDimensionY, sideRight, overallDimensionY, 'pile-total-dimension', 'pile-length', 'general|pileLength')}${zoneDimensions.join('')}${zoneBoundaries.join('')}${noWrapZones.join('')}${longitudinalLines}${spiralLoops.join('')}${hoopLines.join('')}${hoopPlacementSummary}${headLabel}${bendAngleMarker}
      <line class="pile-diameter-dimension" data-pile-edit="general|pileDiameter" data-se-focus="pile-diameter" x1="${(sideRight + 12).toFixed(1)}" y1="${topY.toFixed(1)}" x2="${(sideRight + 12).toFixed(1)}" y2="${bottomY.toFixed(1)}" stroke="${dimColor}" stroke-width="1" marker-start="url(#sePileDimArrow)" marker-end="url(#sePileDimArrow)"/>
      ${labelBox(sideRight + 24, sideMid, `${pileDiameterCm} ס״מ`, 'pile-diameter-label', -90, 'general|pileDiameter')}${pitchLabels.join('')}
    </g>
    <g data-view="top" class="pile-top-engineering-view">
      <text x="${cx.toFixed(1)}" y="${(cy - r - 26).toFixed(1)}" text-anchor="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#12315a">חתך</text>${alternatingLegend}${topHoop}
      <circle data-pile-edit="general|pileDiameter" data-se-focus="pile-diameter" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" stroke="#111827" stroke-width="3"/>
      <circle data-pile-edit="spiral|spiralOuterDiameter" data-se-focus="pile-spiral-diameter pile-spiral-pitch" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.82).toFixed(1)}" fill="none" stroke="${auxColor}" stroke-width="${spiralStroke.toFixed(1)}"/>${topBars}${spacingDimension}
      <line class="pile-dimension-line pile-top-diameter" data-pile-edit="general|pileDiameter" data-se-focus="pile-diameter" x1="${(cx - r).toFixed(1)}" y1="${(cy + r + 16).toFixed(1)}" x2="${(cx + r).toFixed(1)}" y2="${(cy + r + 16).toFixed(1)}" stroke="${dimColor}" stroke-width="1" marker-start="url(#sePileDimArrow)" marker-end="url(#sePileDimArrow)"/>
      <text data-pile-edit="general|pileDiameter" data-se-focus="pile-diameter" x="${cx.toFixed(1)}" y="${(cy + r + 30).toFixed(1)}" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#111827">Ø${pileDiameterCm} ס״מ</text>
      <text data-pile-edit="spiral|spiralDiameter" data-se-focus="pile-spiral-diameter" x="${(cx - r * 0.95).toFixed(1)}" y="${(cy + r + 30).toFixed(1)}" text-anchor="middle" font-size="9" font-family="Heebo,Arial" font-weight="900" fill="#111827">Ø${spiralDiameter} מ״מ</text>
    </g>
  </g>`;
};


/* A lift is a purchased bundle of bars of one diameter and one length.
   Geometry is only the bar itself; the package weight is the weighed value,
   never a computed one, so no machine output is derived from it. */
function LiftEngine() {}
LiftEngine.render = function(lift, w = 300, h = 260) {
  const diameter = Math.max(0, Number(lift?.diameter ?? 0) || 0);
  const barLengthMm = Math.max(0, Number(lift?.barLength ?? 0) || 0);
  const packages = Math.max(0, Number(lift?.quantity ?? 0) || 0);
  const weighed = Math.max(0, Number(lift?.weighedKg ?? 0) || 0);
  const f = (n) => n.toFixed(1);
  const bw = Math.min(w * 0.62, 230);
  const bh = Math.min(h * 0.34, 86);
  const x = (w - bw) / 2;
  const y = (h - bh) / 2 - 4;
  const rows = 4;
  const gap = bh / (rows + 1);
  let bars = "";
  for (let i = 1; i <= rows; i++) {
    const by = y + gap * i;
    bars += `<line class="lift-bar" data-se-focus="lift-diameter lift-bar-length" x1="${f(x + 10)}" y1="${f(by)}" x2="${f(x + bw - 10)}" y2="${f(by)}" stroke="#1a2332" stroke-width="${Math.max(2, Math.min(6, diameter * 0.28)).toFixed(1)}" stroke-linecap="round"/>`;
  }
  let g = `<g data-engine="LiftEngine" data-family="lifts" data-diameter="${diameter}" data-bar-length="${barLengthMm}" data-packages="${packages}" data-weighed-kg="${weighed}">`;
  g += `<rect data-se-focus="lift-packages" x="${f(x)}" y="${f(y)}" width="${f(bw)}" height="${f(bh)}" rx="3" fill="#fff" stroke="#1a2332" stroke-width="2.2"/>`;
  g += bars;
  // strapping bands, the visual cue that this is a bundle and not a single bar
  g += `<line x1="${f(x + bw * 0.28)}" y1="${f(y - 4)}" x2="${f(x + bw * 0.28)}" y2="${f(y + bh + 4)}" stroke="#1a2332" stroke-width="2.4"/>`;
  g += `<line x1="${f(x + bw * 0.72)}" y1="${f(y - 4)}" x2="${f(x + bw * 0.72)}" y2="${f(y + bh + 4)}" stroke="#1a2332" stroke-width="2.4"/>`;
  g += `<text data-se-focus="lift-bar-length" x="${f(w / 2)}" y="${f(y - 16)}" text-anchor="middle" font-size="12" font-family="Heebo,Arial" font-weight="800" fill="#1a2533">L ${barLengthMm ? Math.round(barLengthMm / 10) : "—"} ס״מ</text>`;
  g += `<text data-se-focus="lift-diameter" x="${f(w / 2)}" y="${f(y + bh + 22)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#526070">&#216;${diameter || "—"} מ״מ</text>`;
  g += `<text data-se-focus="lift-packages lift-weighed" x="${f(w / 2)}" y="${f(y + bh + 38)}" text-anchor="middle" font-size="11" font-family="Heebo,Arial" font-weight="800" fill="#526070">${packages || "—"} חבילות · ${weighed ? weighed.toFixed(1) + " ק״ג סה״כ" : "טרם נשקל"}</text>`;
  g += `</g>`;
  return g;
};

function SpiralEngine() {}
SpiralEngine.render = function(spiral, w = 300, h = 260) {
  const barDia     = Math.max(1, Number(spiral?.barDiameter    || 8));
  const spiralDia  = Math.max(1, Number(spiral?.spiralDiameter || spiral?.spiralDiameterMm || 400));
  const turns      = Math.max(1, Number(spiral?.turns          || 20));

  const compact = w <= 160 || h <= 110;
  if (compact) {
    const cx = w / 2;
    const cy = h * 0.56;
    const outerRadius = Math.max(14, Math.min(w * 0.27, h * 0.34));
    const points = [];
    const samples = 120;
    for (let index = 0; index <= samples; index += 1) {
      const progress = index / samples;
      const theta = progress * 4.25 * Math.PI * 2;
      const radius = 2 + (outerRadius - 2) * progress;
      points.push([cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius]);
    }
    const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
    return `<g data-engine="SpiralEngine" data-family="spirals" data-bar-diameter="${barDia}" data-spiral-diameter="${spiralDia}" data-turns="${turns}">
      <text data-spiral-turn-count="1" x="${cx.toFixed(1)}" y="12" text-anchor="middle" font-size="10" font-family="Heebo,Arial" font-weight="900" fill="#1a2332">N=${turns}</text>
      <path d="${path}" fill="none" stroke="#111827" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="${(cx - outerRadius).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + outerRadius).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#c9621a" stroke-width="1.2"/>
      <path d="M ${(cx - outerRadius).toFixed(1)} ${(cy - 4).toFixed(1)} V ${(cy + 4).toFixed(1)} M ${(cx + outerRadius).toFixed(1)} ${(cy - 4).toFixed(1)} V ${(cy + 4).toFixed(1)}" stroke="#c9621a" stroke-width="1.2"/>
    </g>`;
  }

  // Computed
  const circumference = Math.PI * spiralDia;
  const totalLengthMm = Math.round(turns * circumference);

  const pad = 32;
  const cx = w / 2, cy = h * 0.42;
  const rx = Math.min((w - pad * 2) / 2, 90);
  const ry = rx * 0.28; // ellipse depth for 3D feel

  const barW = Math.max(2, barDia * 0.25);

  // Draw coil turns as stacked ellipses (side view)
  const displayTurns = Math.min(turns, 14);
  const turnH = Math.min(12, (h * 0.55) / Math.max(1, displayTurns));
  const totalH = displayTurns * turnH;
  const startY = cy - totalH / 2;

  let coils = '';
  for (let i = 0; i < displayTurns; i++) {
    const y = startY + i * turnH + turnH / 2;
    const opacity = 0.55 + 0.45 * (i / Math.max(1, displayTurns - 1));
    // front half arc
    coils += `<path d="M ${(cx - rx).toFixed(1)},${y.toFixed(1)} A ${rx},${ry} 0 0,1 ${(cx + rx).toFixed(1)},${y.toFixed(1)}"
      fill="none" stroke="#111827" stroke-width="${barW.toFixed(1)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>`;
    // back half arc (dashed, lighter)
    coils += `<path d="M ${(cx + rx).toFixed(1)},${y.toFixed(1)} A ${rx},${ry} 0 0,1 ${(cx - rx).toFixed(1)},${y.toFixed(1)}"
      fill="none" stroke="#6b7280" stroke-width="${(barW * 0.7).toFixed(1)}" stroke-linecap="round" stroke-dasharray="4 3" opacity="${(opacity * 0.6).toFixed(2)}"/>`;
  }
  if (turns > displayTurns) {
    coils += `<text x="${cx.toFixed(1)}" y="${(startY + totalH + 14).toFixed(1)}" text-anchor="middle"
      font-size="9" font-family="Heebo,Arial" fill="#7a93ab">... N=${turns}</text>`;
  }

  // Top-view circle (bottom-right)
  const tCx = w * 0.80, tCy = h * 0.80, tR = Math.min(w * 0.13, 28);
  const topView = `<circle cx="${tCx.toFixed(1)}" cy="${tCy.toFixed(1)}" r="${tR.toFixed(1)}"
      fill="none" stroke="#111827" stroke-width="${barW.toFixed(1)}"/>
    <text x="${tCx.toFixed(1)}" y="${(tCy + tR + 13).toFixed(1)}" text-anchor="middle"
      font-size="9" font-family="Heebo,Arial" fill="#526070">Ø ${formatLengthCmFromMm(spiralDia)}</text>`;

  // Dimension arrows
  const arrowY1 = startY - 6, arrowY2 = startY + totalH + 6;
  const arrowX  = cx - rx - 14;
  const dimLine = `<line x1="${arrowX}" y1="${arrowY1.toFixed(1)}" x2="${arrowX}" y2="${arrowY2.toFixed(1)}"
      stroke="#526070" stroke-width="1" marker-start="url(#se-arr)" marker-end="url(#se-arr)"/>
    <text x="${(arrowX - 6).toFixed(1)}" y="${((arrowY1 + arrowY2) / 2).toFixed(1)}"
      text-anchor="middle" font-size="9" font-family="Heebo,Arial" fill="#526070"
      transform="rotate(-90 ${(arrowX - 6).toFixed(1)} ${((arrowY1 + arrowY2) / 2).toFixed(1)})">N=${turns}</text>`;

  // Labels
  const specLabel = `<text x="${(cx).toFixed(1)}" y="${(h - 8).toFixed(1)}" text-anchor="middle"
    font-size="10" font-family="Heebo,Arial" font-weight="800" fill="#526070">Ø${barDia} מ״מ | קוטר ${displayNumber(spiralDia / 10)} ס״מ | N=${turns} | ${displayNumber(totalLengthMm / 10)} ס״מ</text>`;

  return `<g data-engine="SpiralEngine" data-family="spirals"
    data-bar-diameter="${barDia}" data-spiral-diameter="${spiralDia}" data-turns="${turns}">
    ${coils}${topView}${specLabel}
  </g>`;
};

function RingEngine() {}
RingEngine.render = function(ring, w = 300, h = 260) {
  const barDia = Math.max(1, Number(ring?.barDiameter || ring?.barDiameterMm || 18));
  const ringDia = Math.max(1, Number(ring?.ringDiameter || ring?.ringDiameterMm || ring?.bendingDiameterMm || ring?.spiralDiameter || 420));
  const overlap = Math.max(0, Number(ring?.overlap || ring?.overlapMm || 0));
  const circumferenceMm = Math.round(Math.PI * ringDia);
  const totalLengthMm = Math.round(circumferenceMm + overlap);
  const compact = w <= 160 || h <= 110;
  const cx = compact && overlap > 0 ? w * 0.56 : w / 2;
  const cy = compact ? h * 0.46 : h * 0.43;
  const r = Math.max(16, Math.min((w - 60) / 2, (h - (compact ? 24 : 92)) / 2, compact ? 30 : 78));
  const barW = Math.max(2.4, Math.min(9, barDia * 0.28));
  const circleLength = 2 * Math.PI * r;
  const gapPx = Math.max(10, Math.min(24, r * 0.3));
  const overlapArc = `M ${(cx - r * 0.88).toFixed(1)} ${(cy + r * 0.46).toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 0 ${(cx - r * 0.18).toFixed(1)} ${(cy + r * 0.98).toFixed(1)}`;
  const overlapPath = overlap > 0
    ? `<path data-se-focus="ring-overlap" d="${overlapArc}" fill="none" stroke="#3d5e78" stroke-width="${barW.toFixed(1)}" stroke-linecap="round"/>`
    : '';
  const dimensionY = cy;
  const compactOverlapGuide = compact && overlap > 0 ? `<g data-ring-overlap-dimension="1" font-family="Heebo,Arial">
    <path d="M ${(cx - r * 0.55).toFixed(1)} ${(cy + r * 0.82).toFixed(1)} L 7 ${(h - 15).toFixed(1)}" fill="none" stroke="#c9621a" stroke-width="1.2"/>
    <text x="5" y="${(h - 4).toFixed(1)}" text-anchor="start" font-size="9" font-weight="900" fill="#c9621a">חפיפה ${(overlap / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ</text>
  </g>` : '';
  const labels = compact ? compactOverlapGuide : `<g font-family="Heebo,Arial">
    <text data-se-focus="ring-diameter" x="${cx.toFixed(1)}" y="${(cy - 7).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="900" fill="#c9621a">Ø ${(ringDia / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ</text>
    <text data-se-focus="ring-overlap" x="${(cx - r - 12).toFixed(1)}" y="${(cy + r * 0.82).toFixed(1)}" text-anchor="end" font-size="10" font-weight="900" fill="#c9621a">חפיפה ${(overlap / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ</text>
    <text x="${cx.toFixed(1)}" y="${(h - 28).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="#526070">היקף ${(circumferenceMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ</text>
    <text x="${cx.toFixed(1)}" y="${(h - 10).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="900" fill="#15803d">אורך חיתוך ${(totalLengthMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ</text>
  </g>`;
  return `<g data-engine="RingEngine" data-family="spirals" data-shape-type="ring" data-bar-diameter="${barDia}" data-ring-diameter-mm="${ringDia}" data-overlap-mm="${overlap}" data-circumference-mm="${circumferenceMm}" data-total-length-mm="${totalLengthMm}">
    <circle data-se-focus="ring-diameter" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#111827" stroke-width="${barW.toFixed(1)}" stroke-linecap="round" stroke-dasharray="${(circleLength - gapPx).toFixed(1)} ${gapPx.toFixed(1)}" transform="rotate(128 ${cx.toFixed(1)} ${cy.toFixed(1)})"/>
    ${overlapPath}
    <line data-se-focus="ring-diameter" x1="${(cx - r).toFixed(1)}" y1="${dimensionY.toFixed(1)}" x2="${(cx + r).toFixed(1)}" y2="${dimensionY.toFixed(1)}" stroke="#c9621a" stroke-width="1.3"/>
    <path d="M ${(cx-r).toFixed(1)} ${(dimensionY-5).toFixed(1)} V ${(dimensionY+5).toFixed(1)} M ${(cx+r).toFixed(1)} ${(dimensionY-5).toFixed(1)} V ${(dimensionY+5).toFixed(1)}" stroke="#c9621a" stroke-width="1.3"/>
    ${labels}
  </g>`;
};

function ShapeEngineRouter(shape) {
  const family = shape?.family || 'bars';
  if (family === 'mesh')    return MeshEngine;
  if (family === 'piles')   return PileCageEngine;
  if (isStandaloneRingShape(shape)) return RingEngine;
  if (family === 'spirals') return SpiralEngine;
  if (family === 'lifts')   return LiftEngine;
  return PolylineBarEngine;
}
ShapeEngineRouter.render = function(shape, w = 300, h = 260, opts = {}) {
  return ShapeEngineRouter(shape).render(shape, w, h, opts);
};
const SAVED_SHAPES_KEY = 'ironbend_saved_shapes';

function loadSavedShapes() {
  try { return JSON.parse(localStorage.getItem(SAVED_SHAPES_KEY) || '[]'); }
  catch { return []; }
}
function persistSavedShape(shapeData, name) {
  const shapes = loadSavedShapes();
  const id = 'u' + Date.now();
  const family = shapeData.family || 'bars';
  const entry = { id, name: (name || 'צורה מותאמת').trim(), family, savedAt: Date.now() };
  if (family === 'spirals') {
    entry.specialty      = isStandaloneRingShape(shapeData) ? 'ring' : 'spiral';
    entry.shapeType      = entry.specialty;
    entry.barDiameter    = shapeData.barDiameter    || 8;
    entry.spiralDiameter = shapeData.spiralDiameter || 400;
    entry.turns          = entry.specialty === 'ring' ? 1 : (shapeData.turns || 20);
    if (entry.specialty === 'ring') {
      entry.ringDiameter = shapeData.ringDiameter || shapeData.spiralDiameter || 420;
      entry.overlap = Math.max(0, Number(shapeData.overlap || 0));
    }
  } else if (family === 'mesh') {
    Object.assign(entry, {
      length: shapeData.length, width: shapeData.width,
      longitudinalDiameter: shapeData.longitudinalDiameter, longitudinalSpacing: shapeData.longitudinalSpacing,
      transverseDiameter: shapeData.transverseDiameter, transverseSpacing: shapeData.transverseSpacing,
      edgeLeft: shapeData.edgeLeft, edgeRight: shapeData.edgeRight,
      edgeTop: shapeData.edgeTop, edgeBottom: shapeData.edgeBottom,
    });
  } else if (family === 'piles') {
    Object.assign(entry, {
      pileDiameter: shapeData.pileDiameter, pileLength: shapeData.pileLength,
      longitudinalBars: shapeData.longitudinalBars, longitudinalDiameter: shapeData.longitudinalDiameter,
      barSpacingDisplayMode: String(shapeData.barSpacingDisplayMode || 'center') === 'clear' ? 'clear' : 'center',
      longitudinalBarOverrides: normalizePileBarOverrides(shapeData.longitudinalBarOverrides || [], shapeData.longitudinalBars || 0),
      spiralDiameter: shapeData.spiralDiameter, spiralZones: shapeData.spiralZones,
    });
  } else {
    entry.sides    = [...(shapeData.sides || [])];
    entry.angles   = [...(shapeData.angles || [])];
    entry.is3d     = shapeData.is3d ? 1 : 0;
    entry.azAngles = shapeData.is3d && shapeData.azAngles ? [...shapeData.azAngles] : null;
    entry.elAngles = shapeData.is3d && shapeData.elAngles ? [...shapeData.elAngles] : null;
    entry.bends    = (shapeData.angles || []).length;
  }
  shapes.push(entry);
  localStorage.setItem(SAVED_SHAPES_KEY, JSON.stringify(shapes));
  return id;
}
function deleteSavedShape(id) {
  const shapes = loadSavedShapes().filter(s => s.id !== id);
  localStorage.setItem(SAVED_SHAPES_KEY, JSON.stringify(shapes));
}

// ── WEIGHT ────────────────────────────────────────────────────────
function calcItemWeight(diameter, sides, qty) {
  const kgPerM = sharedKgPerMeter(diameter);
  const totalMm = (sides || []).reduce((s, l) => s + Number(l || 0), 0);
  return (totalMm / 1000) * kgPerM * (qty || 1);
}

function weightPerMeter(diameter) {
  return sharedKgPerMeter(diameter);
}


function shapeContractGuid() {
  const cryptoObj = window.crypto || window.msCrypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rand()}${rand()}-${rand()}-${rand()}-${rand()}-${rand()}${rand()}${rand()}`;
}

function shapeMachineProfiles() {
  const empty = () => ({ status: 'not_implemented', profileVersion: null, payload: null });
  return { MEP: empty(), PEDAX: empty(), SCHNELL: empty() };
}

function normalizeShapeFamily(shape) {
  const f = shape?.family;
  return (f === 'mesh' || f === 'piles' || f === 'spirals' || f === 'lifts') ? f : 'bars';
}

function resolveShapeType(shape) {
  const family = normalizeShapeFamily(shape);
  if (shape?.shapeType) return String(shape.shapeType);
  if (isStandaloneRingShape(shape)) return 'ring';
  if (family === 'mesh')    return 'mesh_rectangular';
  if (family === 'piles')   return 'round_pile_cage';
  if (family === 'spirals') return 'spiral';
  if (family === 'lifts')   return 'lift_package';
  const sides = Array.isArray(shape?.sides) ? shape.sides : [];
  const angles = Array.isArray(shape?.angles) ? shape.angles : [];
  if (family === 'bars' && sides.length === 1 && angles.length === 0) return 'straight_bar';
  if (shape?.presetId) return String(shape.presetId);
  if (shape?.id) return String(shape.id);
  return 'custom_bar';
}

function resolveShapeId(shape) {
  return String(shape?.shapeId || shape?.approvedShapeId || shapeContractGuid());
}

function countMeshBars(total, spacing, edgeStart = 0, edgeEnd = 0) {
  const length = Math.max(1, Number(total) || 1);
  const pitch = Math.max(1, Number(spacing) || 1);
  const start = Math.min(length, Math.max(0, Number(edgeStart) || 0));
  const end = Math.max(start, length - Math.min(length, Math.max(0, Number(edgeEnd) || 0)));
  const positions = [];
  for (let mm = start; mm <= end + 0.001; mm += pitch) positions.push(Math.min(end, mm));
  if (!positions.length || positions[positions.length - 1] !== end) positions.push(end);
  return positions.length;
}

function pileSpiralLengthMm(pileDiameter, zoneLength, pitch) {
  const diameter = Math.max(1, Number(pileDiameter) || 1);
  const length = Math.max(0, Number(zoneLength) || 0);
  const step = Math.max(1, Number(pitch) || 1);
  const turns = length / step;
  const circumference = Math.PI * diameter;
  return Math.round(Math.sqrt((circumference * turns) ** 2 + length ** 2));
}

function validateShapeContractData(family, data) {
  const errors = [];
  const positive = (field, label = field) => {
    if (!(Number(data[field]) > 0)) errors.push(`${label} must be greater than 0`);
  };
  if (!['bars', 'mesh', 'piles', 'spirals', 'lifts'].includes(family)) errors.push('family must be bars, mesh, piles, spirals, or lifts');
  if (Object.prototype.hasOwnProperty.call(data, 'quantity')) errors.push('quantity belongs to Order Item, not Shape');
  if (family === 'lifts') {
    positive('diameter');
    positive('barLength', 'barLength');
    if (!(Number(data.weighedKg) >= 0)) errors.push('weighedKg must be 0 or greater');
  } else if (family === 'bars') {
    if (!Array.isArray(data.sides) || data.sides.length === 0) errors.push('sides must be a non-empty array');
    if (!Array.isArray(data.angles)) errors.push('angles must be an array');
    if (Array.isArray(data.sides) && Array.isArray(data.angles) && ![data.sides.length - 1, data.sides.length].includes(data.angles.length)) errors.push('angles.length must equal sides.length - 1 for open bars or sides.length for closed bars');
    (data.sides || []).forEach((value, index) => { if (!(Number(value) > 0)) errors.push(`sides[${index}] must be greater than 0`); });
    (data.angles || []).forEach((value, index) => { const n = Number(value); if (!Number.isFinite(n) || n < -360 || n > 360) errors.push(`angles[${index}] must be between -360 and 360`); });
    positive('diameter');
  } else if (family === 'mesh') {
    ['length', 'width', 'longitudinalDiameter', 'longitudinalSpacing', 'transverseDiameter', 'transverseSpacing'].forEach(field => positive(field));
    ['edgeLeft', 'edgeRight', 'edgeTop', 'edgeBottom'].forEach(field => { if (!(Number(data[field]) >= 0)) errors.push(`${field} must be 0 or greater`); });
    if (Number(data.edgeLeft) + Number(data.edgeRight) >= Number(data.length)) errors.push('edgeLeft + edgeRight must be smaller than length');
    if (Number(data.edgeTop) + Number(data.edgeBottom) >= Number(data.width)) errors.push('edgeTop + edgeBottom must be smaller than width');
    if ('sides' in data || 'angles' in data) errors.push('mesh must not use sides or angles');
  } else if (family === 'piles') {
    ['pileDiameter', 'pileLength', 'longitudinalDiameter', 'spiralDiameter'].forEach(field => positive(field));
    if (!(Number(data.longitudinalBars) >= 3)) errors.push('longitudinalBars must be at least 3');
    if (!Array.isArray(data.spiralZones) || data.spiralZones.length === 0) errors.push('spiralZones must be a non-empty array');
    let zoneTotal = 0;
    (data.spiralZones || []).forEach((zone, index) => {
      if (!String(zone.name || '').trim()) errors.push(`spiralZones[${index}].name is required`);
      if (!(Number(zone.length) > 0)) errors.push(`spiralZones[${index}].length must be greater than 0`);
      if (!zone.noWrap && !(Number(zone.pitch) > 0)) errors.push(`spiralZones[${index}].pitch must be greater than 0`);
      zoneTotal += Number(zone.length) || 0;
    });
    if (zoneTotal > Number(data.pileLength)) errors.push('sum(spiralZones.length) must not exceed pileLength');
    if ('sides' in data || 'angles' in data) errors.push('pile cages must not use sides or angles');
  } else if (family === 'spirals') {
    ['barDiameter', 'spiralDiameter', 'turns'].forEach(field => positive(field));
    if (data.shapeType === 'ring' || data.ringDiameterMm != null || data.overlapMm != null) {
      positive('ringDiameterMm');
      if (!(Number(data.overlapMm) >= 0)) errors.push('overlapMm must be 0 or greater');
    }
  }
  return { valid: errors.length === 0, errors };
}

function buildBarsShapeContract(shape) {
  const canonical = canonicalSteelRebarShapes().buildBarsShapeContract(shape || {});
  // A smooth bar is the same physical diameter for geometry/weight purposes,
  // but it is a distinct manufacturing/material specification. Keep that fact
  // in the canonical shape snapshot instead of encoding it in the diameter.
  const steelFinish = String(shape?.steelFinish || shape?.steel_finish || '').toLowerCase() === 'smooth'
    ? 'smooth'
    : 'ribbed';
  const finishMetadata = steelFinish === 'smooth' ? { steelFinish } : {};
  const data = { ...canonical.data, ...finishMetadata };
  const generic = { ...canonical.generic, ...finishMetadata };
  return {
    data,
    calculated: canonical.calculated,
    generic,
    validation: validateShapeContractData('bars', data),
  };
}

function buildMeshShapeContract(shape) {
  const data = {
    length: Math.max(1, Number(shape?.length || 600)),
    width: Math.max(1, Number(shape?.width || 250)),
    longitudinalDiameter: Math.max(1, Number(shape?.longitudinalDiameter || 8)),
    longitudinalSpacing: Math.max(1, Number(shape?.longitudinalSpacing || 20)),
    transverseDiameter: Math.max(1, Number(shape?.transverseDiameter || 8)),
    transverseSpacing: Math.max(1, Number(shape?.transverseSpacing || 20)),
    edgeLeft: Math.max(0, Number(shape?.edgeLeft || 0)),
    edgeRight: Math.max(0, Number(shape?.edgeRight || 0)),
    edgeTop: Math.max(0, Number(shape?.edgeTop || 0)),
    edgeBottom: Math.max(0, Number(shape?.edgeBottom || 0)),
  };
  const longitudinalBarCount = countMeshBars(data.width, data.longitudinalSpacing, data.edgeTop, data.edgeBottom);
  const transverseBarCount = countMeshBars(data.length, data.transverseSpacing, data.edgeLeft, data.edgeRight);
  const longitudinalTotalLengthMm = longitudinalBarCount * data.length;
  const transverseTotalLengthMm = transverseBarCount * data.width;
  const totalLengthMm = longitudinalTotalLengthMm + transverseTotalLengthMm;
  const weightKg = Number((((longitudinalTotalLengthMm / 1000) * sharedKgPerMeter(data.longitudinalDiameter)) + ((transverseTotalLengthMm / 1000) * sharedKgPerMeter(data.transverseDiameter))).toFixed(3));
  const calculated = { longitudinalBarCount, transverseBarCount, longitudinalTotalLengthMm, transverseTotalLengthMm, totalLengthMm, weightKg };
  return {
    data,
    calculated,
    generic: { family: 'mesh', shapeType: 'mesh_rectangular', ...data, longitudinalBarCount, transverseBarCount, totalLengthMm },
    validation: validateShapeContractData('mesh', data),
  };
}

function buildPileShapeContract(shape) {
  const pile = PileCageEngine.calculate(shape || {});
  return {
    data: pile.data,
    calculated: pile.calculated,
    generic: pile.machineOutput.generic,
    validation: pile.validation,
  };
}

function buildSpiralShapeContract(shape) {
  const canonical = canonicalSteelRebarShapes().buildSpiralShapeContract(shape || {});
  return {
    data: canonical.data,
    calculated: canonical.calculated,
    generic: canonical.generic,
    validation: validateShapeContractData('spirals', canonical.data),
  };
}

function buildLiftShapeContract(shape) {
  const data = {
    diameter: Math.max(0, Number(shape?.diameter || 0)),
    barLength: Math.max(0, Number(shape?.barLength || 0)),
    weighedKg: Math.max(0, Number(shape?.weighedKg || 0)),
  };
  // All the packages go on the scale together, so the weighed number is the
  // total for the whole line. The package count is there to be counted, never
  // to multiply the weighing.
  // The contract carries a single weight and mirrors it into totalWeightKg,
  // because quantity belongs to the order item. That mirroring is exactly
  // what marks this number as a whole-line total rather than a per-unit one.
  const weightKg = Number(data.weighedKg.toFixed(3));
  const calculated = { totalLengthMm: data.barLength, weightKg, weighedKg: weightKg };
  return {
    data,
    calculated,
    generic: { family: 'lifts', shapeType: 'lift_package', ...data },
    validation: validateShapeContractData('lifts', data),
  };
}

function buildRingShapeContract(shape) {
  const canonical = canonicalSteelRebarShapes().buildRingShapeContract({
    ...shape,
    barDiameterMm: shape?.barDiameter ?? shape?.barDiameterMm,
    bendingDiameterMm: shape?.ringDiameter ?? shape?.ringDiameterMm ?? shape?.spiralDiameter,
    overlapMm: shape?.overlap ?? shape?.overlapMm ?? 0,
    quantity: 1,
  });
  const { quantity: _orderItemQuantity, ...canonicalData } = canonical.data || {};
  const data = { ...canonicalData, shapeType: 'ring' };
  return {
    data,
    calculated: canonical.calculated,
    generic: canonical.generic,
    validation: validateShapeContractData('spirals', data),
  };
}

function finiteShapeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundShapeMetric(value, digits = 3) {
  const numeric = finiteShapeNumber(value, 0);
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function normalizeShapeVersionValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.round(numeric)) : 1;
}

function cleanShapePayload(value, depth = 0) {
  if (Array.isArray(value)) return value.map(entry => cleanShapePayload(entry, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    return value;
  }
  return Object.entries(value).reduce((payload, [key, entry]) => {
    if (entry === undefined || (depth === 0 && (key === 'quantity' || key === 'qty'))) return payload;
    payload[key] = cleanShapePayload(entry, depth + 1);
    return payload;
  }, {});
}

function normalizeCalculatedPayload(calculated = {}) {
  const payload = cleanShapePayload(calculated || {});
  if (Object.prototype.hasOwnProperty.call(payload, 'totalLengthMm')) {
    payload.totalLengthMm = roundShapeMetric(payload.totalLengthMm);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'weightKg')) {
    payload.weightKg = roundShapeMetric(payload.weightKg);
    payload.totalWeightKg = payload.weightKg;
  } else if (Object.prototype.hasOwnProperty.call(payload, 'totalWeightKg')) {
    payload.totalWeightKg = roundShapeMetric(payload.totalWeightKg);
    payload.weightKg = payload.totalWeightKg;
  }
  return payload;
}

function normalizeGenericMachineOutput(generic = {}, calculated = {}, family, shapeType) {
  const payload = cleanShapePayload({ ...(generic || {}), family, shapeType });
  if (!Object.prototype.hasOwnProperty.call(payload, 'totalLengthMm') && calculated.totalLengthMm != null) {
    payload.totalLengthMm = calculated.totalLengthMm;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'weightKg') && calculated.weightKg != null) {
    payload.weightKg = calculated.weightKg;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'totalWeightKg') && calculated.totalWeightKg != null) {
    payload.totalWeightKg = calculated.totalWeightKg;
  }
  payload.units = {
    length: 'mm',
    weight: 'kg',
    angle: 'deg',
  };
  return payload;
}

function normalizeShapeValidation(familyPayload, calculated, approvedAt) {
  const errors = Array.isArray(familyPayload.validation?.errors) ? [...familyPayload.validation.errors] : [];
  const warnings = Array.isArray(familyPayload.validation?.warnings) ? [...familyPayload.validation.warnings] : [];
  if (!(Number(calculated.totalLengthMm) > 0)) errors.push('calculated.totalLengthMm must be greater than 0');
  if (!(Number(calculated.weightKg) > 0)) warnings.push('calculated.weightKg is missing or zero');
  return {
    valid: Boolean(familyPayload.validation?.valid) && errors.length === 0,
    errors,
    warnings,
    timestamp: approvedAt,
  };
}

function buildShapeDataContractV2(shape) {
  const safeShape = shape && typeof shape === 'object' ? shape : {};
  const family = normalizeShapeFamily(safeShape);
  const shapeType = resolveShapeType({ ...safeShape, family });
  const familyPayload = family === 'lifts'
    ? buildLiftShapeContract(safeShape)
    : family === 'mesh'
    ? buildMeshShapeContract(safeShape)
    : family === 'piles'
      ? buildPileShapeContract(safeShape)
      : family === 'spirals'
        ? (isStandaloneRingShape(safeShape) ? buildRingShapeContract(safeShape) : buildSpiralShapeContract(safeShape))
        : buildBarsShapeContract(safeShape);
  const approvedAt = new Date().toISOString();
  const displayName = String(safeShape.displayName || safeShape.presetName || safeShape.shapeName || safeShape.name || '');
  const data = cleanShapePayload(familyPayload.data || {});
  const calculated = normalizeCalculatedPayload(familyPayload.calculated || {});
  const generic = normalizeGenericMachineOutput(familyPayload.generic || {}, calculated, family, shapeType);
  const validation = normalizeShapeValidation(familyPayload, calculated, approvedAt);
  const machineOutput = {
    generic,
    machineProfiles: shapeMachineProfiles(),
  };
  const baseSnapshot = {
    shapeVersion: normalizeShapeVersionValue(safeShape.shapeVersion),
    shapeId: resolveShapeId(safeShape),
    shapeType,
    family,
    source: 'shape-editor',
    approvedAt,
    displayName,
    data,
    calculated,
    machineOutput,
    validation,
    extra: {
      calculation: {
        engine: 'shape-editor',
        contract: 'SHAPE_DATA_CONTRACT_V2',
        precision: { lengthMm: 1, weightKg: 0.001 },
      },
    },
  };
  const snapshotBuilder = window.IronBendShapeSnapshot?.buildFullShapeSnapshot;
  if (snapshotBuilder) return snapshotBuilder(baseSnapshot);
  return {
    contractVersion: 2,
    ...baseSnapshot,
    ...baseSnapshot.extra,
  };
}

function legacyApprovedShapeFields(shape, contract) {
  const family = contract.family;
  const base = {
    presetId: shape?.presetId || shape?.id || contract.shapeType,
    presetName: shape?.presetName || shape?.name || contract.displayName,
    presetEmoji: shape?.presetEmoji || shape?.emoji || '',
    shapeName: shape?.shapeName || shape?.presetName || shape?.name || contract.displayName,
    shapeId: contract.shapeId,
    shapeType: contract.shapeType,
    family,
  };
  if (family === 'mesh' || family === 'piles') return { ...base, ...contract.data };
  if (family === 'spirals') return {
    ...base,
    ...contract.data,
    diameter: contract.data.barDiameter,
    total_length_mm: contract.calculated?.totalLengthMm || 0,
    segments: JSON.stringify([{ length: contract.calculated?.totalLengthMm || 0 }]),
  };
  return {
    ...base,
    sides: [...contract.data.sides],
    angles: [...contract.data.angles],
    diameter: contract.data.diameter,
    ...(contract.data.steelFinish ? { steelFinish: contract.data.steelFinish } : {}),
    is3d: shape?.is3d ? 1 : 0,
    azAngles: shape?.is3d ? (shape.azAngles || []) : null,
    elAngles: shape?.is3d ? (shape.elAngles || []) : null,
    ...(contract.data.roundedBends ? { roundedBends: true, radiusMm: contract.data.radiusMm ?? null } : {}),
  };
}

// ── SHAPE EDITOR CLASS ────────────────────────────────────────────
class ShapeEditorModal {
  constructor(onSelect) {
    this.onSelect   = onSelect;
    this.current    = null;
    this._camTheta  = Math.PI / 4; // camera azimuth  (default 45°, matches isometric)
    this._camPhi    = Math.PI / 4; // camera elevation (default 45°, matches isometric)
    this._activeSeg = null;        // index of highlighted segment (null = none)
    this._pileCageTemplateMode = null;
    this._activePileSection = 'general';
    this._build();
  }

  _build() {
    if (document.getElementById('seOverlay')) {
      this._el = document.getElementById('seOverlay');
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'seOverlay';
    overlay.innerHTML = `
<style>
#seOverlay {
  position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2000;
  display:flex;align-items:center;justify-content:center;
  opacity:0;pointer-events:none;transition:opacity 0.2s;backdrop-filter:blur(4px);
}
#seOverlay.show{opacity:1;pointer-events:all;}
#seModal{
  background:#ffffff;border:1px solid #d0d8e4;border-radius:12px;
  width:min(1180px,96vw);max-height:95vh;overflow:hidden;
  display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.25);
  transform:translateY(16px);transition:transform 0.2s;
}
#seOverlay.show #seModal{transform:translateY(0);}
#seModal .se-head{
  padding:16px 20px;border-bottom:1px solid #d8e2ec;
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
  background:#1a2332;
}
#seModal .se-head h2{font-size:15px;font-weight:800;color:#e8edf3;}
#seModal .se-close{width:36px;height:36px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
  border-radius:8px;color:#e8edf3;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;}
/* ── Count picker buttons ── */
.se-count-btn{padding:16px 20px;border-radius:14px;border:2px solid #dde4ed;
  background:#fff;cursor:pointer;font-family:'Heebo',sans-serif;text-align:center;
  min-width:142px;transition:all 0.15s;display:flex;flex-direction:column;align-items:center;gap:6px;}
.se-count-btn:hover{border-color:#e07b39;background:rgba(224,123,57,0.05);
  transform:translateY(-2px);box-shadow:0 4px 16px rgba(224,123,57,0.2);}
.se-count-btn .cnt-num{font-size:28px;font-weight:900;color:#1a2332;}
.se-count-btn .cnt-lbl{font-size:11px;color:#7a93ab;}
.se-count-btn .cnt-name{font-size:13px;font-weight:900;color:#1a2332;}
.se-count-btn svg{width:112px;height:80px;display:block;margin:0 auto;}
.se-row-active td{background:rgba(41,121,255,0.07)!important;border-bottom:1px solid rgba(41,121,255,0.2)!important;}
.se-row-active td:first-child{border-right:3px solid #2979ff!important;}
.se-row-active .se-seg-label{background:#2979ff!important;}
/* ── Page 1: shape selection ── */
#sePageSelect{background:#f4f6f9;}
#seModal .se-preset-btn{
  padding:12px 8px 10px;border-radius:12px;border:1.5px solid #dde4ed;
  background:#ffffff;color:#526070;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:12px;font-weight:600;
  text-align:center;transition:all 0.15s;display:flex;flex-direction:column;
  align-items:center;gap:4px;min-height:100px;
  -webkit-tap-highlight-color:transparent;
}
#seModal .se-preset-btn:hover{border-color:#aab8c8;color:#1a2332;background:#edf1f7;transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,0.08);}
#seModal .se-preset-btn.active{background:rgba(224,123,57,0.08);border-color:#e07b39;color:#e07b39;box-shadow:0 0 0 3px rgba(224,123,57,0.15);}
#seModal .se-preset-btn svg path{transition:stroke 0.15s;}
#seModal .se-preset-btn.active svg [stroke*="rebarGrad"]{stroke:#e07b39!important;}
/* ── Page 2: edit layout ── */
#sePageEdit{flex:1;display:flex;overflow:hidden;min-height:0;}
.se-preview-panel{flex:1;display:flex;flex-direction:column;padding:14px 16px;gap:10px;background:#fff;overflow:hidden;min-width:0;}
.se-data-panel{width:360px;flex-shrink:0;border-right:1px solid #e2e8ef;display:flex;flex-direction:column;overflow:hidden;background:#fff;}
.se-data-panel-head{padding:12px 14px 8px;border-bottom:1px solid #e2e8ef;font-size:11px;font-weight:700;color:#7a93ab;text-transform:uppercase;letter-spacing:0.5px;background:#f9fafb;}
/* Stats bar (horizontal) */
.se-stats-bar{display:flex;gap:8px;flex-shrink:0;}
#seModal .se-stat{flex:1;background:#f4f6f9;border:1px solid #e2e8ef;border-radius:8px;padding:10px 12px;}
#seModal .se-stat-label{font-size:9px;font-weight:700;color:#7a93ab;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}
#seModal .se-stat-value{font-size:20px;font-weight:900;color:#e07b39;}
#seModal .se-stat-unit{font-size:11px;color:#7a93ab;font-weight:400;}
/* Back button */
.se-back-btn{padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.2);
  background:rgba(255,255,255,0.08);color:#c8d4e0;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:13px;font-weight:600;
  transition:all .15s;white-space:nowrap;}
.se-back-btn:hover{background:rgba(255,255,255,0.15);color:#fff;}
/* SVG */
#seModal .se-svg-wrap{
  background:#f7f9fc;border:1px solid #dbe4ef;
  border-radius:12px;flex:1;display:flex;align-items:center;justify-content:center;
  min-height:420px;user-select:none;overflow:hidden;
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.9);
}
#seModal .se-svg-wrap.grab-mode{cursor:grab;}
#seModal .se-svg-wrap.grab-mode:active{cursor:grabbing;}
#se3DOrbitCtrl{
  display:flex;align-items:center;justify-content:center;gap:6px;padding:4px 0;
}
#se3DOrbitCtrl .se-rot-btn{
  width:32px;height:32px;border-radius:8px;border:1px solid #d0d8e4;
  background:#f0f4f8;color:#1a2332;cursor:pointer;font-size:15px;
  display:flex;align-items:center;justify-content:center;
  transition:background 0.12s, border-color 0.12s;
  font-family:Heebo,Arial,sans-serif;
}
#se3DOrbitCtrl .se-rot-btn:hover{background:rgba(224,123,57,0.12);border-color:#e07b39;color:#e07b39;}
#se3DOrbitCtrl .se-rot-btn:active{background:rgba(224,123,57,0.25);}
#se3DOrbitCtrl .se-rot-label{font-size:9px;color:#7a93ab;font-family:Heebo,Arial;}
#seModal .se-svg-wrap svg{width:100%;height:100%;min-height:520px;max-height:100%;}
#seModal .se-info-col{width:200px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;}
#seModal .se-stat{background:#f4f6f9;border:1px solid #e2e8ef;border-radius:8px;padding:12px 14px;}
#seModal .se-stat-label{font-size:10px;font-weight:700;color:#7a93ab;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;}
#seModal .se-stat-value{font-size:22px;font-weight:900;color:#e07b39;}
#seModal .se-stat-unit{font-size:12px;color:#7a93ab;font-weight:400;}
#seModal .se-table-wrap{flex:1;overflow-y:auto;}
#seModal .se-table{width:100%;min-width:0!important;border-collapse:collapse;}
#seModal .se-table,
#seModal .se-table thead,
#seModal .se-table tbody,
#seModal .se-table tr,
#seModal .se-table th,
#seModal .se-table td{
  box-sizing:border-box!important;
  min-width:0!important;
  max-width:100%!important;
}
#seModal .se-table th{
  text-align:right;font-size:10px;font-weight:700;color:#7a93ab;text-transform:uppercase;
  letter-spacing:0.5px;padding:8px 10px;border-bottom:1px solid #e2e8ef;
  background:#f4f6f9;position:sticky;top:0;
}
#seModal .se-table td{padding:7px 8px;border-bottom:1px solid #f0f3f7;color:#1a2332;}
#seModal .se-table tr:last-child td{border-bottom:none;}
#seModal .se-table tr:hover td{background:#fafbfd;}
#seModal .se-input{
  width:100%;padding:7px 10px;background:#ffffff;
  border:1.5px solid #d8e2ec;border-radius:7px;
  color:#1a2332;font-family:'Heebo',sans-serif;font-size:14px;direction:rtl;
  min-height:38px;
}
#seModal .se-table td:nth-child(2) .se-input{max-width:96px;margin-inline-start:auto;}
#seModal .se-table td:nth-child(3) .se-input{max-width:78px;margin-inline-start:auto;}
#seModal .se-input:focus{outline:none;border-color:#e07b39;background:#fffaf6;box-shadow:0 0 0 3px rgba(224,123,57,0.12);}
#seModal .se-direct-edit-note{font-size:11px;font-weight:700;color:#7a93ab;margin-inline-start:12px;}
#seModal .se-angle-btns{display:flex;gap:4px;flex-wrap:wrap;}
#seModal .se-angle-btn{
  padding:4px 10px;border-radius:6px;border:1px solid #d8e2ec;
  background:#f4f6f9;color:#526070;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:11px;font-weight:700;
  transition:all 0.15s;-webkit-tap-highlight-color:transparent;
}
#seModal .se-angle-btn:hover{border-color:#e07b39;color:#e07b39;background:#fff6f0;}
#seModal .se-angle-btn.active{background:rgba(224,123,57,0.12);border-color:#e07b39;color:#e07b39;}
#seModal .se-seg-label{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:50%;background:#1a2332;
  color:#ffffff;font-size:11px;font-weight:700;flex-shrink:0;
}
#seModal .se-bend-row{background:#fffaf6;}
#seModal .se-table th span{font-size:9px;opacity:0.7;}
#seModal .se-mode-note{padding:10px 14px;border-bottom:1px solid #e2e8ef;background:#fbfcfe;display:grid;gap:8px;}
#seModal .se-3d-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #d8e2ec;border-radius:8px;padding:9px 10px;background:#fff;}
#seModal .se-3d-toggle strong{font-size:13px;color:#1a2332;}
#seModal .se-3d-toggle small{display:block;font-size:11px;color:#7a93ab;font-weight:500;line-height:1.45;}
#seModal .se-switch{position:relative;width:44px;height:24px;flex-shrink:0;}
#seModal .se-switch input{opacity:0;width:0;height:0;}
#seModal .se-slider{position:absolute;cursor:pointer;inset:0;background:#c8d4e0;border-radius:999px;transition:.15s;}
#seModal .se-slider:before{content:"";position:absolute;width:18px;height:18px;right:3px;top:3px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 4px rgba(0,0,0,.18);}
#seModal .se-switch input:checked + .se-slider{background:#e07b39;}
#seModal .se-switch input:checked + .se-slider:before{transform:translateX(-20px);}
#seModal .se-3d-help{font-size:11px;color:#7a93ab;line-height:1.55;}
#seModal .se-add-row{
  display:flex;gap:8px;padding:10px 0 4px;
}
#seModal .se-add-btn{
  padding:7px 14px;border-radius:7px;border:1.5px dashed #c8d4e0;
  background:transparent;color:#7a93ab;cursor:pointer;font-family:'Heebo',sans-serif;
  font-size:12px;font-weight:600;transition:all 0.15s;
}
#seModal .se-add-btn:hover{border-color:#e07b39;color:#e07b39;}
#seModal .se-del-btn{
  width:28px;height:28px;border-radius:6px;border:1px solid transparent;
  background:transparent;color:#b0bece;cursor:pointer;font-size:14px;
  display:flex;align-items:center;justify-content:center;transition:all 0.15s;
}
#seModal .se-del-btn:hover{background:rgba(231,76,60,0.1);border-color:#e74c3c;color:#e74c3c;}
#seModal .se-foot{
  padding:12px 16px;border-top:1px solid #e2e8ef;
  display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;background:#f9fafb;
}
#seModal .se-cancel-btn{
  padding:10px 20px;border-radius:8px;border:1px solid #d8e2ec;
  background:#ffffff;color:#526070;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:14px;font-weight:700;
}
#seModal .se-cancel-btn:hover{border-color:#b0bece;background:#f4f6f9;}
#seModal .se-save-shape-btn{
  padding:10px 18px;border-radius:8px;border:1.5px solid #3a7bd5;
  background:rgba(58,123,213,0.07);color:#3a7bd5;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:14px;font-weight:700;
  transition:all 0.15s;
}
#seModal .se-save-shape-btn:hover{background:rgba(58,123,213,0.14);border-color:#2c62b8;}
.se-saved-section-title{padding:10px 16px 6px;font-size:11px;font-weight:700;color:#3a7bd5;
  text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:6px;}
#seShapeTooltip{
  position:fixed;z-index:9999;pointer-events:none;
  background:#fff;border:1.5px solid #dde4ed;border-radius:14px;
  box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:10px 12px 8px;
  display:none;flex-direction:column;align-items:center;gap:4px;
  min-width:160px;
}
#seShapeTooltip svg{display:block;}
#seShapeTooltip .se-tip-name{font-family:Heebo,sans-serif;font-size:12px;font-weight:700;color:#1a2332;text-align:center;}
.se-del-saved-btn{position:absolute;top:4px;left:4px;width:20px;height:20px;
  border-radius:50%;border:none;background:rgba(231,76,60,0.12);color:#e74c3c;
  cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;
  padding:0;line-height:1;opacity:0;transition:opacity 0.15s;}
.se-preset-btn:hover .se-del-saved-btn{opacity:1;}
#seModal .se-ok-btn{
  padding:10px 28px;border-radius:8px;border:none;
  background:linear-gradient(135deg,#e07b39,#f0954d);color:white;cursor:pointer;
  font-family:'Heebo',sans-serif;font-size:14px;font-weight:800;
  box-shadow:0 4px 16px rgba(224,123,57,0.3);
}
#seModal .se-ok-btn:hover{transform:translateY(-1px);}

/* Easybar-inspired production workspace */
#seOverlay{
  background:rgba(32,33,36,0.62);
  backdrop-filter:none;
  align-items:center;
  justify-content:center;
}
#seOverlay.show #seModal{transform:none;}
#seModal{
  width:100vw;
  height:100vh;
  max-height:100vh;
  border-radius:0;
  border:0;
  background:#d9d9d9;
  box-shadow:none;
  color:#243047;
}
#seModal .se-head{
  min-height:54px;
  padding:10px 20px;
  background:#202633;
  border-bottom:1px solid rgba(255,255,255,0.06);
}
#seModal .se-head h2{font-size:15px;color:#f3f6fa;}
#sePageEdit{
  flex:1;
  display:flex;
  min-height:0;
  background:#d9d9d9;
  direction:ltr;
  overflow:hidden;
}
#sePageEdit .se-preview-panel,
#sePageEdit .se-data-panel{direction:rtl;}
#sePageEdit[style*="display:none"]{display:none!important;}
.se-preview-panel{
  flex:1;
  order:1;
  background:#d9d9d9;
  padding:16px 28px 18px;
  gap:10px;
}
.se-data-panel{
  order:2;
  width:332px;
  min-width:0;
  background:#eef0f3;
  border-right:1px solid #c9cdd4;
  border-left:0;
  overflow:hidden;
}
.se-data-panel-head{
  min-height:56px;
  padding:18px 22px 12px;
  background:#eef0f3;
  border-bottom:1px solid #c9cdd4;
  color:#243047;
  font-size:18px;
  font-weight:900;
  text-transform:none;
  letter-spacing:0;
}
#seModal .se-mode-note{
  background:#eef0f3;
  border-bottom:1px solid #c9cdd4;
  padding:14px 18px;
}
#seModal .se-3d-toggle{
  border:0;
  border-radius:0;
  padding:0;
  background:transparent;
}
#seModal .se-3d-toggle strong{font-size:14px;}
#seModal .se-3d-toggle small{color:#667286;}
#seModal .se-switch input:checked + .se-slider{background:#ff4047;}
#seModal .se-table-wrap{
  background:#eef0f3;
  padding:12px 16px 16px;
  overflow-x:hidden;
}
#seModal .se-table{
  border-collapse:separate;
  border-spacing:0 8px;
  table-layout:fixed;
}
#seModal .se-table thead,
#seModal .se-table tbody{display:block;width:100%;min-width:0;}
#seModal .se-table tr{
  display:grid;
  grid-template-columns:34px minmax(0,1fr) minmax(0,1fr) 30px;
  align-items:center;
  width:100%;
  min-width:0;
}
#seModal .se-table.se-table-3d tr{
  grid-template-columns:30px repeat(3,minmax(0,1fr)) 28px;
}
#seModal .se-table th,
#seModal .se-table td{
  min-width:0;
}
#seModal .se-table th{
  background:transparent;
  border-bottom:0;
  color:#667286;
  font-size:11px;
  position:static;
}
#seModal .se-table td{
  background:#ffffff;
  border-top:1px solid #d8dde5;
  border-bottom:1px solid #d8dde5;
  padding:8px 5px;
}
#seModal .se-table td:first-child{
  border-right:1px solid #d8dde5;
  border-radius:0 8px 8px 0;
}
#seModal .se-table td:last-child{
  border-left:1px solid #d8dde5;
  border-radius:8px 0 0 8px;
}
#seModal .se-table tr:hover td{background:#fbfcfe;}
#seModal .se-seg-label{
  width:30px;
  height:34px;
  background:#2f394b;
  border-radius:50%;
  font-size:13px;
}
.se-row-active td{background:#fff3f3!important;border-color:#ff4047!important;}
.se-row-active td:first-child{border-right:1px solid #ff4047!important;}
.se-row-active .se-seg-label{background:#ff4047!important;}
#seModal .se-add-row{justify-content:center;}
#seModal .se-add-btn{
  width:100%;
  min-height:40px;
  border-radius:8px;
  border:0;
  background:#5b6474;
  color:#fff;
  font-weight:800;
}
#seModal .se-add-btn:hover{background:#2f394b;color:#fff;}
#seModal .se-svg-wrap{
  background:#ffffff;
  border:0;
  border-radius:0;
  min-height:420px;
  box-shadow:none;
}
#seModal .se-svg-wrap svg{
  width:100%;
  height:380px;
  max-height:100%;
}
#seModal .se-stats-bar{
  background:#d9d9d9;
  gap:8px;
}
#seModal .se-stat{
  min-width:110px;
  background:#eef0f3;
  border:1px solid #c9cdd4;
  border-radius:8px;
  padding:8px 12px;
}
#seModal .se-stat-label{
  color:#667286;
  letter-spacing:0;
  text-transform:none;
}
#seModal .se-stat-value{color:#243047;font-size:19px;}
#seModal .se-direct-edit-note{
  color:#667286;
  white-space:nowrap;
}
#seView2D,#seView3D,#seResetCam{
  min-height:34px;
  border-radius:8px;
}
#se3DOrbitCtrl{
  align-self:center;
  background:#eef0f3!important;
  border:1px solid #c9cdd4!important;
  border-radius:10px!important;
  padding:6px 10px!important;
}
#se3DOrbitCtrl .se-rot-btn{
  border-radius:50%!important;
  background:#858d9a!important;
  border:0!important;
  color:#fff!important;
}
#se3DOrbitCtrl .se-rot-btn:hover{background:#2f394b!important;color:#fff!important;}
#seModal .se-foot{
  background:#eef0f3;
  border-top:1px solid #c9cdd4;
}
#seModal .se-ok-btn{
  border-radius:8px;
  background:#ff4047;
  box-shadow:none;
}
#seModal .se-save-shape-btn{
  border-color:#5b6474;
  color:#2f394b;
  background:#fff;
}
#seModal .se-cancel-btn{
  border-color:#c9cdd4;
  color:#2f394b;
}
#sePageSelect{
  background:#d9d9d9!important;
}
#seFamilyTabs{
  display:flex;
  justify-content:flex-end;
  gap:10px;
  padding:16px 24px 10px;
  background:#eef0f3;
  border-bottom:1px solid #d5dae1;
}
#seFamilyTabs .se-family-tab{
  min-width:82px;
  height:30px;
  border:1px solid #b9c3d0;
  border-radius:6px;
  background:#f7f8fa;
  color:#647083;
  font-family:'Heebo',sans-serif;
  font-size:14px;
  font-weight:800;
}
#seFamilyTabs .se-family-tab.active{
  background:#fff;
  color:#172235;
  border-color:#263449;
}
#seCategoryFilters{
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:10px 12px;
  padding:14px 24px 6px;
  background:#eef0f3;
}
#seCategoryFilters .se-category-filter{
  min-width:78px;
  height:34px;
  border:0;
  border-radius:6px;
  background:#5f6878;
  color:#fff;
  font-family:'Heebo',sans-serif;
  font-size:14px;
  font-weight:900;
}
#seCategoryFilters .se-category-filter.active{background:#ff4047;}
#seCategoryFilters .se-category-filter:disabled{opacity:.45;cursor:default;}
#seSideFilters{
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:8px;
  padding:4px 24px 12px;
  background:#eef0f3;
  border-bottom:1px solid #d5dae1;
}
#seSideFilters .se-side-filter{
  min-width:42px;
  height:30px;
  border:1px solid #c2cad5;
  border-radius:6px;
  background:#fff;
  color:#5f6878;
  font-family:'Heebo',sans-serif;
  font-size:13px;
  font-weight:900;
}
#seSideFilters .se-side-filter.active{background:#2f394b;color:#fff;border-color:#2f394b;}
#seModal .se-preset-btn{
  width:58px;
  height:58px;
  min-height:58px;
  padding:0;
  border:0;
  border-radius:50%;
  background:#858d9a;
  color:#fff;
  display:grid;
  place-items:center;
}
#seModal .se-preset-btn svg{width:38px;height:38px;margin:0!important;display:block;}
#seModal .se-preset-btn:hover{background:#5b6474;color:#fff;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.14);}
#seModal .se-preset-btn.active{
  background:#2f394b;
  border-color:transparent;
  color:#fff;
  box-shadow:none;
}
#seModal .se-preset-name{display:block;font-size:11px;font-weight:700;color:#1a2332;text-align:center;margin-top:4px;line-height:1.3;word-break:break-word;}


/* One-screen shape edit layout: keep a single shape editable without page scroll */
#seModal{overflow:hidden;}
#sePageEdit{
  height:calc(100vh - 118px);
  max-height:calc(100vh - 118px);
  overflow:hidden;
}
#sePageEdit .se-preview-panel,
#sePageEdit .se-data-panel{
  height:100%;
  min-height:0;
}
.se-preview-panel{
  padding:10px 18px 8px;
  gap:8px;
}
#seModal .se-canvas-topbar{
  min-height:44px;
  gap:10px;
}
#seModal .se-svg-wrap{
  flex:1 1 auto;
  min-height:0;
  height:calc(100vh - 246px);
  max-height:calc(100vh - 246px);
}
#seModal .se-svg-wrap svg{
  height:100%;
  min-height:0;
}
.se-data-panel{
  display:flex;
  flex-direction:column;
  min-height:0;
}
.se-data-panel-head{
  min-height:42px;
  padding:12px 18px 8px;
  font-size:16px;
}
#seModal .se-mode-note{
  padding:10px 16px;
  flex-shrink:0;
}
#seModal .se-3d-help{
  font-size:10px;
  line-height:1.35;
}
#seModal .se-table-wrap{
  flex:1 1 auto;
  min-height:0;
  overflow-y:auto;
  padding:8px 14px 10px;
}
#seModal .se-panel-summary{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
  padding:12px 16px 4px;
  background:#eef0f3;
  border-top:1px solid #d3d8df;
}
#seModal .se-panel-summary-item{
  min-width:0;
  background:#fff;
  border:1px solid #d8dde5;
  border-radius:8px;
  padding:8px 10px;
}
#seModal .se-panel-summary-main{
  grid-column:1 / -1;
  display:flex;
  align-items:center;
  justify-content:space-between;
  border-color:#e07b39;
  box-shadow:0 0 0 2px rgba(224,123,57,.10);
}
#seModal .se-panel-summary-item span{
  display:block;
  color:#667286;
  font-size:10px;
  font-weight:800;
  line-height:1.2;
}
#seModal .se-panel-summary-item strong{
  color:#243047;
  font-size:18px;
  font-weight:900;
  line-height:1.15;
}
#seModal .se-panel-summary-main strong{
  color:#df5000;
}
#seModal .se-panel-summary-item small{
  margin-inline-start:3px;
  color:#667286;
  font-size:10px;
  font-weight:700;
}
#seModal .se-table{border-spacing:0 6px;}
#seModal .se-table td{padding:6px 5px;}
#seModal .se-input{min-height:36px;padding:6px 10px;}
#seModal .se-table .se-input{
  width:100%!important;
  max-width:none!important;
  min-width:0;
  box-sizing:border-box;
}
#seModal .se-table.se-table-3d .se-input{
  padding-inline:7px;
  font-size:13px;
}
#seModal .se-angle-btn{padding:5px 8px;min-width:54px;}
#seModal .se-add-row{padding:6px 0 0!important;}

#seModal .se-family-row td{background:#fff;border-top:1px solid #d8dde5;border-bottom:1px solid #d8dde5;}
#seModal .se-family-row td:first-child{border-right:1px solid #d8dde5;border-radius:0 8px 8px 0;}
#seModal .se-family-row td:last-child{border-left:1px solid #d8dde5;border-radius:8px 0 0 8px;}
#seModal .se-family-row>td[colspan]{grid-column:1/-1!important;width:100%;min-width:0;display:block;}
#seModal .se-family-label{font-size:11px;font-weight:900;color:#526070;line-height:1.25;align-self:stretch;display:flex;align-items:center;}
#seModal .se-family-editor-table tr{grid-template-columns:minmax(0,.8fr) minmax(0,1fr) minmax(0,.8fr) minmax(0,1fr)!important;}
#seModal .se-family-editor-table .se-zone-row{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) 30px!important;}
#seModal .se-family-editor-table .se-zone-head td{background:transparent;border:0;color:#667286;font-size:10px;font-weight:900;text-transform:uppercase;}
#seModal .se-add-btn{min-height:34px;}
#seModal .se-foot{
  min-height:58px;
  height:58px;
  padding:8px 16px;
}
#seModal .se-ok-btn,
#seModal .se-save-shape-btn,
#seModal .se-cancel-btn{
  min-height:40px;
  padding-top:8px;
  padding-bottom:8px;
}
@media(max-height:760px){
  #seModal .se-head{min-height:48px;padding-top:8px;padding-bottom:8px;}
  #sePageEdit{height:calc(100vh - 102px);max-height:calc(100vh - 102px);}
  #seModal .se-svg-wrap{height:calc(100vh - 220px);max-height:calc(100vh - 220px);}
  #seModal .se-stat{padding:6px 10px;}
  #seModal .se-stat-value{font-size:17px;}
  #seModal .se-foot{height:54px;min-height:54px;}
}
@media(max-width:760px){
  #seModal{width:100vw;height:100vh;max-height:100vh;border-radius:0;}
  #sePageEdit{flex-direction:column;}
  .se-preview-panel{order:1;padding:10px;background:#d9d9d9;}
  .se-data-panel{order:2;width:100%;max-height:42vh;border-right:none;border-top:1px solid #c9cdd4;}
  #seModal .se-svg-wrap{min-height:44vh;}
  #seModal .se-direct-edit-note{display:none;}
}
@media(max-width:640px){
  #seModal{width:100vw;max-height:100vh;border-radius:0;}
  #sePageEdit{flex-direction:column;}
  .se-data-panel{width:100%;border-right:none;border-top:1px solid #e2e8ef;max-height:40vh;}
  #seModal .se-svg-wrap{min-height:260px;}
  #seModal .se-presets{width:100%;flex-direction:row;overflow-x:auto;overflow-y:hidden;border-left:none;border-bottom:1px solid #e2e8ef;padding:8px;flex-wrap:nowrap;max-height:60px;}
  #seModal .se-preset-btn{flex-shrink:0;white-space:nowrap;}
  #seModal .se-preview-row{flex-direction:column;}
  #seModal .se-info-col{width:100%;flex-direction:row;}
}


/* Approved TENA reference layout - UI only */
#seModal .se-head{min-height:64px;padding:0 18px;display:grid;grid-template-columns:260px minmax(0,1fr) 280px;gap:16px;align-items:center;background:#171d2b;border-bottom:0;direction:ltr;}
#seModal .se-brand{display:flex;align-items:center;justify-content:flex-end;gap:12px;direction:rtl;}
#seModal .se-brand img{width:174px;height:58px;object-fit:contain;background:#fff;padding:4px 10px;display:block;}
#seModal .se-head-center{display:flex;align-items:center;justify-content:center;gap:12px;direction:rtl;min-width:0;}
#seModal .se-head h2{font-size:18px;font-weight:900;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#seModal .se-step-indicator{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;color:#d7dfec;background:rgba(255,255,255,.06);font-size:12px;font-weight:800;white-space:nowrap;}
#seModal .se-head-actions{display:flex;align-items:center;gap:10px;direction:rtl;}
#seModal .se-close{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18);border-radius:50%;}
#seModal .se-back-btn{min-height:38px;padding:8px 14px;border-radius:8px;color:#eef4fb;background:rgba(255,255,255,.09);font-weight:900;}
#sePageEdit{height:calc(100vh - 132px);max-height:calc(100vh - 132px);display:grid!important;grid-template-columns:360px minmax(0,1fr) 154px;direction:rtl;background:#d7d7d7;}
#sePageEdit[style*="display:none"]{display:none!important;}
#sePageEdit .se-family-panel{order:3;background:#eceeef;border-left:1px solid #c5cbd4;padding:18px 14px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;}
#sePageEdit .se-family-panel-title{font-size:15px;font-weight:900;color:#243047;margin-bottom:2px;}
#sePageEdit .se-family-card{width:100%;min-height:92px;border:1px solid #d1d7df;border-radius:8px;background:#fff;color:#243047;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-family:'Heebo',sans-serif;font-weight:900;cursor:pointer;transition:all .15s;}
#sePageEdit .se-family-card svg{width:46px;height:38px;color:#5f6878;}
#sePageEdit .se-family-card span{font-size:14px;}
#sePageEdit .se-family-card.active{border-color:#ff4047;box-shadow:0 0 0 3px rgba(255,64,71,.14);color:#ff4047;}
#sePageEdit .se-family-card:hover{transform:translateY(-1px);border-color:#5f6878;}
#sePageEdit .se-preview-panel{order:2;background:#d7d7d7;padding:16px 18px 14px;gap:10px;min-width:0;}
#sePageEdit .se-data-panel{order:1;width:auto;background:#eef0f3;border-right:1px solid #c5cbd4;border-left:0;}
#seModal .se-canvas-topbar{min-height:48px;justify-content:space-between;background:#d7d7d7;}
#seModal .se-view-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
#seModal .se-view-label{font-size:12px;font-weight:900;color:#4b5565;}
#seModal .se-svg-wrap{background:#fff;border:0;min-height:0;height:calc(100vh - 254px);max-height:calc(100vh - 254px);border-radius:0;box-shadow:none;}
#seModal .se-svg-wrap svg{height:100%;min-height:0;}
#se3DOrbitCtrl{order:-1;align-self:auto;justify-content:flex-start;background:#eef0f3!important;border:1px solid #c5cbd4!important;border-radius:8px!important;padding:6px 8px!important;}
#seModal .se-data-panel-head{display:flex;align-items:center;gap:8px;min-height:42px;padding:8px 14px;background:#eef0f3;border-bottom:1px solid #c5cbd4;color:#243047;font-size:17px;font-weight:900;text-transform:none;letter-spacing:0;}
#seModal .se-data-panel-head:before{content:'⚙';font-size:18px;}
#seModal .se-mode-note{padding:8px 14px;background:#eef0f3;border-bottom:1px solid #c5cbd4;}
#seModal .se-3d-toggle strong{font-size:14px;color:#243047;}
#seModal .se-3d-toggle small,#seModal .se-3d-help{color:#647083;font-size:11px;}
#seModal .se-panel-summary{display:none!important;}
#seModal .se-table-wrap{padding:6px 10px 8px;background:#eef0f3;overflow-x:hidden;}
#seModal .se-table th{font-size:10px;color:#5f6878;text-transform:none;letter-spacing:0;font-weight:900;padding:4px 5px;}
#seModal .se-table tr{grid-template-columns:28px minmax(0,1fr) minmax(0,.62fr) 22px;gap:5px;align-items:center;}
#seModal .se-table.se-table-3d tr{grid-template-columns:28px minmax(0,1fr) minmax(0,.72fr) minmax(0,.66fr) 22px;gap:5px;align-items:center;}
#seModal .se-table td{background:#fff;border:1px solid #d8dde5;border-radius:6px!important;padding:3px;min-width:0;overflow:hidden;}
#seModal .se-table td.se-empty-cell{background:transparent;border:0!important;padding:0;box-shadow:none;display:flex;align-items:center;justify-content:center;}
#seModal .se-no-bend{font-size:13px;color:#aab8c8;font-weight:900;line-height:1;}
#seModal .se-field-shell{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'label label' 'input unit';gap:1px 3px;align-items:center;min-width:0;}
#seModal .se-param-icon{grid-area:icon;width:14px;height:14px;border-radius:50%;background:#eef3f8;color:#2f394b;display:grid;place-items:center;font-size:8px;font-weight:900;}
#seModal .se-param-label{grid-area:label;color:#243047;font-size:10px;font-weight:900;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#seModal .se-field-shell .se-input{grid-area:input;width:100%!important;max-width:none!important;min-height:24px;font-size:12px;font-weight:900;text-align:center;background:#f8fafc;border:1px solid #cbd4df;border-radius:6px;direction:ltr;padding:1px 3px;}
#seModal .se-field-shell .se-input:focus{border-color:#ff4047;box-shadow:0 0 0 2px rgba(255,64,71,.12);background:#fff;}
#seModal .se-param-unit{grid-area:unit;color:#657386;font-size:8px;font-weight:900;text-align:center;min-width:18px;}
#seModal .se-param-example{display:none;}
#seModal .se-family-label{font-size:12px;color:#243047;}
#seModal .se-table.se-table-2d tr{grid-template-columns:28px minmax(0,1fr) minmax(0,.58fr) 22px;gap:5px;align-items:center;}
#seModal .se-family-editor-table tr{grid-template-columns:minmax(0,1fr)!important;gap:8px;}
#seModal .se-family-editor-table .se-zone-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(72px,.75fr) 30px!important;}
#seModal .se-family-editor-table .se-family-row td{display:block;}
#seModal .se-family-editor-table .se-zone-head td{background:transparent;border:0;color:#5f6878;font-size:11px;font-weight:900;}
#seModal .se-bottom-summary{display:flex;align-items:center;gap:10px;margin-inline-end:auto;min-width:0;}
#seModal .se-summary-item{min-width:108px;background:#fff;border:1px solid #cfd6df;border-radius:8px;padding:7px 10px;}
#seModal .se-summary-item span{display:block;font-size:10px;color:#647083;font-weight:900;line-height:1.1;}
#seModal .se-summary-item strong{font-size:18px;color:#243047;font-weight:900;line-height:1.1;}
#seModal .se-summary-item small{font-size:10px;color:#647083;font-weight:800;margin-inline-start:3px;}
#seModal .se-quantity-input{width:54px;border:0;background:transparent;color:#243047;font-family:'Heebo',sans-serif;font-size:18px;font-weight:900;line-height:1.1;text-align:center;direction:ltr;padding:0;outline:none;}
#seModal .se-quantity-input:focus{background:#fff;border:1px solid #cfd6df;border-radius:5px;box-shadow:0 0 0 2px rgba(255,64,71,.12);}
#seModal .se-invalid,#seModal .se-invalid:focus{border:1.5px solid #c0392b!important;background:#fdecea!important;color:#c0392b!important;box-shadow:0 0 0 2px rgba(192,57,43,.25)!important;border-radius:5px;}
#seModal .se-summary-item.se-invalid-wrap{outline:1.5px solid #c0392b;outline-offset:2px;border-radius:6px;}
#seModal .se-ok-btn.se-blocked{background:#c0392b!important;opacity:.85;}
#seModal .se-straight-bar-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:4px;}
#seModal .se-straight-bar-row td{padding:8px 10px;}
#seModal .se-straight-bar-fields .se-field-shell{min-height:66px;}
@media (max-width:720px){#seModal .se-straight-bar-fields{grid-template-columns:1fr;}}
#seModal .se-summary-item.primary{border-color:#ff4047;box-shadow:0 0 0 2px rgba(255,64,71,.11);}
#seModal .se-summary-item.primary strong{color:#df5000;}
#seModal .se-foot{height:68px;min-height:68px;padding:10px 16px;background:#eef0f3;border-top:1px solid #c5cbd4;}
#seModal .se-foot-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-shrink:0;}
#seModal .se-ok-btn{background:#ff4047;border:0;border-radius:8px;box-shadow:none;min-width:126px;}
#seModal .se-save-shape-btn{background:#fff;color:#2f394b;border:1px solid #5f6878;border-radius:8px;min-width:116px;}
#seModal .se-cancel-btn{background:#fff;color:#2f394b;border:1px solid #c5cbd4;border-radius:8px;min-width:92px;}
#seModal .se-highlight-family{filter:none!important;}
#seModal .se-field-shell{position:relative;transition:background .14s,border-color .14s,box-shadow .14s;}
#seModal .se-field-shell[data-se-param]{cursor:crosshair;}
#seModal .se-field-shell.se-param-active{background:#fff;border-radius:8px;box-shadow:0 0 0 2px rgba(41,121,255,.16);}
#seModal .se-param-number{position:absolute;inset-inline-start:-3px;top:-6px;width:15px;height:15px;border-radius:50%;background:#243047;color:#fff;display:grid;place-items:center;font-size:8px;font-weight:900;border:2px solid #eef0f3;}
#seModal .se-param-code{grid-area:label;color:#2979ff;font-size:9px;font-weight:900;justify-self:end;}
#seModal svg.se-focus-mode [data-se-focus]{opacity:.16;transition:opacity .14s,stroke .14s,fill .14s,filter .14s;}
#seModal svg.se-focus-mode [data-se-focus].se-focus-hit{opacity:1!important;filter:none!important;}
#seModal svg.se-focus-mode [data-se-focus].se-focus-hit text,#seModal svg.se-focus-mode text.se-focus-hit{fill:#111827!important;stroke:none!important;}
#seModal .se-engineer-helper text{font-family:Heebo,Arial;font-weight:900;fill:#475569;}
#seModal .se-helper-panel{fill:#f8fafc;stroke:#d8dde5;stroke-width:1;}
#seModal .se-pile-compact-row{gap:2px!important;}
#seModal .se-pile-compact-row td{padding:1px 2px!important;border-radius:5px!important;}
#seModal .se-family-editor-table .se-zone-row td{padding:2px!important;border-radius:5px!important;}
#seModal .se-pile-compact-row .se-field-shell{grid-template-columns:minmax(0,1fr);grid-template-areas:'label' 'input';gap:0;min-width:0;}
#seModal .se-family-editor-table .se-zone-row .se-field-shell{grid-template-columns:12px minmax(0,1fr);gap:0 2px;}
#seModal .se-pile-compact-row .se-param-icon,
#seModal .se-pile-compact-row .se-param-code,
#seModal .se-pile-compact-row .se-param-number,
#seModal .se-pile-compact-row .se-param-unit{display:none!important;}
#seModal .se-family-editor-table .se-zone-row .se-param-icon{width:12px;height:12px;font-size:7px;}
#seModal .se-pile-compact-row .se-param-label{font-size:8px;line-height:1;justify-self:center;text-align:center;}
#seModal .se-family-editor-table .se-zone-row .se-param-label{font-size:9px;line-height:1;}
#seModal .se-pile-compact-row .se-field-shell .se-input{min-height:20px;font-size:10px;border-radius:5px;padding:0 3px;}
#seModal .se-family-editor-table .se-zone-row .se-field-shell .se-input{min-height:21px;font-size:11px;border-radius:5px;padding:0 3px;}
#seModal .se-family-editor-table .se-zone-row .se-param-unit{font-size:7px;}
#seModal .se-family-editor-table .se-param-icon,
#seModal .se-family-editor-table .se-param-code,
#seModal .se-family-editor-table .se-param-number,
#seModal .se-family-editor-table .se-param-unit{display:none!important;}
#seModal .se-family-editor-table .se-field-shell{grid-template-columns:minmax(0,1fr)!important;grid-template-areas:'label' 'input'!important;gap:0;min-width:0;}
#seModal .se-family-editor-table .se-param-label{justify-self:center;text-align:center;}
#seModal .se-pile-section-row td{grid-column:1/-1!important;width:100%!important;min-width:0!important;display:block;background:transparent!important;border:0!important;padding:3px 0!important;}
#seModal .se-pile-section{border:1px solid #d8e2ec;border-radius:7px;background:#fff;overflow:hidden;}
#seModal .se-pile-section summary{cursor:pointer;list-style:none;padding:7px 10px;background:#f8fafc;color:#12315a;font-size:12px;font-weight:900;border-bottom:1px solid #e2e8f0;}
#seModal .se-pile-section summary::-webkit-details-marker{display:none;}
#seModal .se-pile-section summary{display:flex;align-items:center;justify-content:space-between;gap:8px;}
#seModal .se-pile-section summary span{font-size:10px;color:#64748b;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#seModal .se-pile-validations{display:grid;gap:5px;padding:4px;}
#seModal .se-pile-validation{border:1px solid #dbe4f0;border-radius:7px;background:#fff;padding:6px 8px;color:#12315a;font-size:11px;font-weight:800;}
#seModal .se-pile-validation.error{border-color:#fecaca;background:#fff1f2;color:#be123c;}
#seModal .se-pile-validation.warning{border-color:#fde68a;background:#fffbeb;color:#92400e;}
#seModal .se-pile-validation.ok{border-color:#bbf7d0;background:#f0fdf4;color:#166534;}
#seModal .se-pile-section[open] summary{background:#eef6ff;}
#seModal .se-pile-section table,#seModal .se-pile-section tbody{display:block;width:100%;min-width:0;}
#seModal .se-pile-section table{border-collapse:separate;border-spacing:0 3px;}
#seModal .se-pile-section tr{width:100%;min-width:0;}
#seModal .se-pile-section .se-family-row{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:4px!important;width:100%;min-width:0;}
#seModal .se-pile-section .se-family-row>td[colspan]{grid-column:1/-1!important;width:100%;min-width:0;display:block;}
#seModal .se-pile-section .se-zone-row{display:grid!important;grid-template-columns:minmax(62px,.85fr) minmax(54px,.75fr) minmax(50px,.7fr) minmax(54px,.7fr) 24px!important;gap:3px!important;}
#seModal .se-pile-section .se-zone-head{font-size:9px;}
#seModal .se-pile-section .se-field-shell .se-input:disabled{opacity:.45;background:#eef2f6;}
#seModal .se-pile-template-row{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:8px;align-items:center;padding:4px 5px;direction:rtl;}
#seModal .se-pile-template-row label{display:grid;gap:3px;color:#12315a;font-size:10px;font-weight:900;}
#seModal .se-pile-template-row select{width:100%;min-height:34px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#1e293b;font-family:Heebo,Arial;font-weight:900;padding:3px 8px;}
#seModal .se-pile-template-note{font-size:10px;line-height:1.35;color:#64748b;font-weight:800;}
#seModal .se-pile-quick-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;padding:2px 0;}
#seModal .se-pile-quick-card{min-width:0;min-height:54px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:6px 7px;display:grid;gap:2px;text-align:right;cursor:pointer;font-family:Heebo,Arial;color:#12315a;}
#seModal .se-pile-quick-card:hover,#seModal .se-pile-quick-card:focus-visible{border-color:#2979ff;box-shadow:0 0 0 2px rgba(41,121,255,.12);outline:0;}
#seModal .se-pile-quick-card span{font-size:9px;font-weight:900;color:#64748b;}
#seModal .se-pile-quick-card strong{font-size:12px;font-weight:900;line-height:1.25;white-space:normal;}
#seModal .se-pile-quick-card small{font-size:9px;font-weight:800;color:#475569;line-height:1.2;white-space:normal;}
#seModal svg [data-pile-edit]{cursor:pointer;}
#seModal .se-pile-action-row td{padding:2px!important;background:transparent!important;border:0!important;}
#seModal .se-pile-action-row .se-add-btn{min-height:28px;font-size:12px;border-radius:6px;}
#seModal .se-pile-bar-editor{border:1px solid #d8e2ec;border-radius:7px;background:#f8fafc;padding:5px;display:grid;gap:4px;min-width:0;}
#seModal .se-pile-bar-editor-head{display:flex;justify-content:space-between;gap:6px;align-items:center;min-width:0;}
#seModal .se-pile-bar-editor-head strong{font-size:12px;color:#12315a;}
#seModal .se-pile-bar-editor-head span,.se-pile-bar-note{font-size:9px;color:#64748b;font-weight:800;line-height:1.15;}
#seModal .se-pile-inline-field .se-family-row td{border:0!important;padding:0!important;background:transparent!important;}
#seModal .se-pile-bar-overrides{display:grid;gap:5px;}
#seModal .se-pile-bar-override-row{display:grid;grid-template-columns:minmax(45px,.6fr) minmax(50px,.7fr) minmax(58px,.8fr) minmax(55px,.7fr) 24px;gap:4px;align-items:end;direction:rtl;}
#seModal .se-pile-bar-override-row label{display:grid;gap:1px;font-size:9px;font-weight:900;color:#526070;}
#seModal .se-pile-bar-override-row .se-input{min-height:22px!important;font-size:11px!important;padding:0 3px!important;border-radius:5px!important;}
#seModal .se-pile-add-override{min-height:26px!important;font-size:12px;border-radius:6px;}
#seModal .se-pile-hoop-row td{padding:2px!important;border-radius:5px!important;}
#seModal .se-pile-hoop-grid{display:grid;grid-template-columns:24px repeat(3,minmax(50px,1fr));gap:4px;align-items:end;direction:rtl;}
#seModal .se-pile-hoop-grid .se-field-shell,#seModal .se-pile-hoop-grid .se-derived-chip{min-width:0;}
#seModal .se-pile-hoop-grid .se-derived-chip{grid-column:span 2;}
#seModal .se-pile-hoop-grid select.se-input{font-size:9px!important;}
#seModal .se-pile-hoop-grid .se-field-shell{grid-template-columns:minmax(0,1fr);grid-template-areas:'label' 'input' 'unit';gap:0;min-width:0;}
#seModal .se-pile-hoop-grid .se-param-icon{display:none;}
#seModal .se-pile-hoop-grid .se-param-code,
#seModal .se-pile-hoop-grid .se-param-number{display:none!important;}
#seModal .se-pile-hoop-grid .se-param-label{font-size:8px;line-height:1;justify-self:center;text-align:center;}
#seModal .se-pile-hoop-grid .se-input{min-height:21px!important;font-size:10px!important;border-radius:5px!important;padding:0 2px!important;}
#seModal .se-pile-hoop-toggle{display:grid;place-items:center;min-height:28px;border:1px solid #d8e2ec;border-radius:6px;background:#fff;}
#seModal .se-pile-hoop-toggle input{width:16px;height:16px;}
#seModal .se-derived-chip{display:grid;place-items:center;min-height:21px;border:1px solid #bdd2ea;border-radius:5px;background:#eef6ff;color:#12315a;font-size:10px;font-weight:900;}
#seModal .se-pile-elements{border:1px solid #d8e2ec;border-radius:7px;background:#fff;padding:5px;display:grid;gap:4px;width:100%;min-width:0;overflow:hidden;}
#seModal .se-pile-elements-head{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px;font-weight:900;color:#12315a;min-width:0;}
#seModal .se-pile-elements-head span{font-size:9px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#seModal .se-pile-cage-overview{display:grid;gap:3px;border:1px solid #c8dff3;border-radius:6px;background:#eff8ff;padding:6px 7px;color:#12315a;}
#seModal .se-pile-cage-overview strong{font-size:11px;}
#seModal .se-pile-cage-overview span{font-size:9px;font-weight:800;line-height:1.2;}
#seModal .se-pile-component-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;}
#seModal .se-pile-component-card{display:grid;gap:3px;border:1px solid #cbd9e7;border-right:4px solid #3667a8;border-radius:7px;background:#fff;padding:7px;min-width:0;}
#seModal .se-pile-component-card-title{font-size:11px;font-weight:900;color:#102d50;}
#seModal .se-pile-component-card-metric{font-size:10px;font-weight:900;color:#1d4f8f;}
#seModal .se-pile-component-card-placement{font-size:9px;font-weight:800;color:#526070;line-height:1.25;}
#seModal .se-pile-component-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;padding:0 2px 4px;direction:rtl;}
#seModal .se-pile-component-gallery[hidden]{display:none!important;}
#seModal .se-pile-component-gallery .se-pile-component-card{appearance:none;text-align:inherit;cursor:pointer;grid-template-columns:112px minmax(0,1fr);align-items:center;min-height:118px;padding:8px;border-right-width:5px;}
#seModal .se-pile-component-visual{width:112px;height:90px;border:1px solid #d8e2ec;border-radius:6px;background:#fff;overflow:hidden;direction:ltr;}
#seModal .se-pile-component-visual svg{display:block;width:100%;height:100%;}
#seModal .se-pile-component-copy{display:grid;gap:5px;min-width:0;}
#seModal .se-pile-component-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;direction:ltr;}
#seModal .se-pile-component-metric{border:1px solid #d8e2ec;border-radius:5px;background:#f8fafc;padding:4px 5px;font:900 10px/1.2 Arial,sans-serif;color:#1a2332;white-space:nowrap;text-align:center;}
#seModal .se-pile-component-card:focus-visible{outline:3px solid rgba(224,123,57,.38);outline-offset:2px;}
#seModal.se-pile-editor #sePageEdit .se-preview-panel{overflow-y:auto;align-content:start;}
#seModal.se-pile-editor #sePageEdit .se-svg-wrap{height:min(52vh,520px);min-height:310px;flex:none;}
#seModal .se-pile-element-row{display:grid;grid-template-columns:minmax(88px,1fr) repeat(4,minmax(38px,.48fr));gap:3px;align-items:center;direction:rtl;border:1px solid #edf1f6;border-radius:6px;background:#f8fafc;padding:3px;min-width:0;}
#seModal .se-pile-element-row strong{font-size:10px;color:#0f2444;line-height:1.12;display:grid;min-width:0;}
#seModal .se-pile-element-row span{font-size:9px;color:#64748b;font-weight:800;line-height:1.15;}
#seModal .se-pile-element-value{border-radius:5px;background:#fff;border:1px solid #d8e2ec;padding:2px 3px;text-align:center;font-size:9px!important;color:#0f2444!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
#seModal .se-pile-element-overrides{display:flex;flex-wrap:wrap;gap:4px;}
#seModal .se-pile-element-overrides span{border:1px solid #bdd2ea;border-radius:999px;background:#eef6ff;color:#12315a;font-size:9px;font-weight:900;padding:2px 6px;}
@media(max-width:640px){#seModal .se-pile-component-cards{grid-template-columns:1fr;}#seModal .se-pile-component-card{padding:8px;}}
@media(max-width:720px){
  #seModal .se-pile-component-gallery{grid-template-columns:1fr;gap:7px;}
  #seModal .se-pile-component-gallery .se-pile-component-card{grid-template-columns:94px minmax(0,1fr);min-height:104px;}
  #seModal .se-pile-component-visual{width:94px;height:78px;}
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{overflow:visible;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{height:300px!important;min-height:300px!important;}
}

@media(max-width:980px){#seModal .se-head{grid-template-columns:1fr;gap:8px;min-height:112px;padding:10px 14px;}#seModal .se-brand{justify-content:center;}#seModal .se-head-actions{justify-content:center;}#sePageEdit{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr) minmax(250px,38vh);}#sePageEdit .se-family-panel{order:1;flex-direction:row;overflow-x:auto;padding:10px;}#sePageEdit .se-family-card{min-width:132px;min-height:74px;}#sePageEdit .se-preview-panel{order:2;padding:10px;}#sePageEdit .se-data-panel{order:3;width:100%;border-top:1px solid #c5cbd4;}#seModal .se-svg-wrap{height:42vh;max-height:42vh;}#seModal .se-foot{height:auto;min-height:82px;}#seFootNormal{flex-wrap:wrap;}#seModal .se-bottom-summary{width:100%;overflow-x:auto;padding-bottom:2px;}#seModal .se-foot-actions{width:100%;}}

@media(min-width:761px) and (max-width:980px){
  body.se-open{overflow:hidden;}
  #seOverlay{align-items:stretch;justify-content:stretch;padding:0;overflow:hidden;}
  #seModal{width:100vw;height:100dvh;max-height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;border-radius:0;}
  #sePageEdit{height:auto;max-height:none;min-height:0;display:grid!important;grid-template-columns:1fr;grid-template-rows:auto minmax(260px,34dvh) minmax(0,1fr);overflow:hidden;padding:0;}
  #sePageEdit .se-family-panel{order:1;display:flex;flex-direction:row;gap:10px;overflow-x:auto;overflow-y:hidden;padding:10px;scroll-snap-type:x proximity;border-left:0;border-bottom:1px solid #c5cbd4;}
  #sePageEdit .se-family-card{flex:0 0 132px;min-height:72px;scroll-snap-align:start;}
  #sePageEdit .se-preview-panel{order:2;min-height:260px;height:auto;padding:10px;overflow:hidden;}
  #seModal .se-svg-wrap{min-height:260px;height:100%;max-height:none;overflow:hidden;}
  #seModal .se-svg-wrap svg{width:100%;height:100%;min-height:0;max-height:100%;}
  #sePageEdit .se-data-panel{order:3;width:100%;min-height:0;overflow:hidden;border-top:1px solid #c5cbd4;}
  #seModal .se-table-wrap{height:100%;overflow-y:auto;overflow-x:hidden;}
  #seModal .se-foot{position:sticky;bottom:0;z-index:5;height:auto;min-height:86px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));}
}

@media(max-width:760px){
  body.se-open{overflow:hidden;}
  #seOverlay{align-items:stretch!important;justify-content:stretch!important;padding:0!important;overflow:hidden!important;}
  #seModal{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;border-radius:0!important;display:grid!important;grid-template-rows:auto minmax(0,1fr) auto!important;overflow:hidden!important;}
  /* Selection is a real mobile screen too: tabs may scroll intentionally, cards must not. */
  #sePageCount>div{padding:24px 12px!important;}
  #seCountBtns{gap:10px!important;}
  #seFamilyTabs{justify-content:flex-start!important;gap:8px!important;padding:10px 12px 8px!important;overflow-x:auto!important;overflow-y:hidden!important;flex-wrap:nowrap!important;scroll-snap-type:x proximity;}
  #seFamilyTabs .se-family-tab{flex:0 0 82px;scroll-snap-align:start;}
  #seCategoryFilters{gap:7px!important;padding:10px 12px 5px!important;}
  #seCategoryFilters .se-category-filter{min-width:68px!important;font-size:12px!important;}
  #seSideFilters{gap:6px!important;padding:4px 12px 9px!important;}
  #sePageSelect #sePresetsTitle{padding:8px 12px 10px!important;font-size:14px!important;}
  #sePageSelect #sePresets{padding:0 12px 16px!important;grid-template-columns:repeat(auto-fill,minmax(58px,1fr))!important;gap:8px!important;}
  #seModal .se-head{min-height:auto!important;padding:8px 10px!important;display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;grid-template-areas:'actions title'!important;gap:8px!important;}
  #seModal .se-brand{display:none!important;}
  #seModal .se-head-actions{grid-area:actions!important;justify-content:flex-start!important;gap:6px!important;}
  #seModal .se-head-center{grid-area:title!important;justify-content:flex-end!important;gap:6px!important;min-width:0!important;}
  #seModal .se-head h2{font-size:15px!important;max-width:138px!important;}
  #seModal .se-step-indicator{font-size:10px!important;padding:5px 7px!important;}
  #seModal .se-close{width:34px!important;height:34px!important;}
  #seModal .se-back-btn{min-height:34px!important;padding:6px 10px!important;font-size:12px!important;}
  /* On phones the editor is one vertical workspace: the BOM must remain reachable
     below the cage fields instead of being hidden inside a second short scroller. */
  #sePageEdit{height:auto!important;max-height:none!important;min-height:0!important;display:grid!important;grid-template-columns:1fr!important;grid-template-rows:auto minmax(220px,32dvh) auto!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch;padding:0!important;direction:rtl!important;}
  #sePageEdit .se-family-panel{order:1!important;width:100%!important;min-width:0!important;display:flex!important;flex-direction:row!important;gap:8px!important;overflow-x:auto!important;overflow-y:hidden!important;padding:8px!important;scroll-snap-type:x proximity!important;border-left:0!important;border-bottom:1px solid #c5cbd4!important;}
  #sePageEdit .se-family-panel-title{display:none!important;}
  #sePageEdit .se-family-card{flex:0 0 96px!important;width:96px!important;min-width:96px!important;min-height:58px!important;height:58px!important;padding:4px 2px!important;gap:3px!important;border-radius:7px!important;scroll-snap-align:start!important;}
  #sePageEdit .se-family-card svg{width:30px!important;height:24px!important;}
  #sePageEdit .se-family-card span{font-size:10px!important;line-height:1.1!important;white-space:normal!important;text-align:center!important;}
  #sePageEdit .se-preview-panel{order:2!important;min-width:0!important;min-height:220px!important;height:auto!important;padding:8px 10px!important;gap:5px!important;overflow:hidden!important;}
  #seModal .se-canvas-topbar{min-height:30px!important;height:30px!important;padding:0!important;gap:4px!important;overflow:hidden!important;}
  #seModal .se-view-controls{gap:4px!important;}
  #seModal .se-view-label{font-size:10px!important;}
  #seModal .se-view-controls button,#se3DOrbitCtrl .se-rot-btn{width:28px!important;height:28px!important;min-width:28px!important;font-size:11px!important;padding:0!important;}
  #se3DOrbitCtrl{display:none!important;}
  #seModal .se-svg-wrap{min-height:220px!important;height:100%!important;max-height:none!important;overflow:hidden!important;}
  #seModal .se-svg-wrap svg{width:100%!important;height:100%!important;min-height:0!important;max-height:100%!important;}
  #sePageEdit .se-data-panel{order:3!important;width:100%!important;min-width:0!important;min-height:auto!important;overflow:visible!important;border-right:0!important;border-top:1px solid #c5cbd4!important;}
  #seModal .se-data-panel-head{min-height:32px!important;padding:6px 10px!important;font-size:14px!important;}
  #seModal .se-mode-note{display:none!important;}
  #seModal .se-table-wrap{height:auto!important;max-height:none!important;overflow:visible!important;padding:6px 8px 18px!important;}
  #seModal .se-table{width:100%!important;min-width:0!important;}
  #seModal .se-table tr,#seModal .se-table.se-table-2d tr{grid-template-columns:24px minmax(0,1fr) minmax(0,.72fr) 22px!important;gap:4px!important;}
  #seModal .se-table.se-table-3d tr{grid-template-columns:22px repeat(3,minmax(0,1fr)) 20px!important;gap:3px!important;}
  #seModal .se-table th{font-size:9px!important;padding:2px 3px!important;}
  #seModal .se-table td{padding:2px!important;}
  /* The circular pile form uses colspan=2 for fields and colspan=5 for section wrappers. */
  #seModal .se-pile-section .se-family-row>td[colspan="2"]{grid-column:auto!important;width:auto!important;display:block;}
  #seModal .se-pile-section .se-family-row>td[colspan="5"]{grid-column:1/-1!important;width:100%!important;}
  #seModal .se-seg-label{width:24px!important;height:28px!important;font-size:10px!important;}
  #seModal .se-field-shell{grid-template-columns:12px minmax(0,1fr)!important;gap:0 2px!important;}
  #seModal .se-param-icon{width:12px!important;height:12px!important;font-size:7px!important;}
  #seModal .se-param-label{font-size:9px!important;}
  #seModal .se-param-unit{font-size:7px!important;}
  #seModal .se-field-shell .se-input{min-height:24px!important;font-size:12px!important;padding:1px 2px!important;}
  #seModal .se-straight-bar-fields{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:4px!important;padding:2px!important;}
  #seModal .se-straight-bar-fields .se-field-shell{min-height:52px!important;}
  #seModal .se-foot{position:sticky!important;bottom:0!important;z-index:5!important;height:auto!important;min-height:104px!important;padding:7px 8px calc(7px + env(safe-area-inset-bottom))!important;overflow:hidden!important;background:#eef0f3!important;border-top:1px solid #c5cbd4!important;}
  #seFootNormal{display:grid!important;grid-template-columns:1fr!important;gap:6px!important;width:100%!important;}
  #seModal .se-bottom-summary{width:100%!important;margin:0!important;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important;overflow:hidden!important;padding:0!important;}
  #seModal .se-bottom-summary .se-summary-item{min-width:0!important;width:auto!important;padding:5px 6px!important;}
  #seModal .se-bottom-summary .se-summary-item:nth-child(n+4){display:none!important;}
  #seModal.se-ring-editor .se-bottom-summary{grid-template-columns:repeat(4,minmax(0,1fr))!important;}
  #seModal.se-ring-editor .se-bottom-summary .se-quantity-item{display:block!important;}
  #seModal .se-summary-item span{font-size:9px!important;}
  #seModal .se-summary-item strong{font-size:14px!important;}
  #seModal .se-summary-item small{font-size:9px!important;}
  #seModal .se-foot-actions{width:100%!important;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:7px!important;}
  #seModal .se-cancel-btn,#seModal .se-save-shape-btn,#seModal .se-ok-btn{width:100%!important;min-width:0!important;min-height:38px!important;padding:7px 6px!important;font-size:13px!important;}
}

@media(max-width:420px){
  #sePageEdit{grid-template-rows:auto minmax(230px,34dvh) minmax(0,1fr)!important;}
  #seModal .se-svg-wrap{min-height:230px!important;}
  #seModal .se-head h2{max-width:118px!important;}
  #seModal .se-step-indicator{font-size:9px!important;padding-inline:6px!important;}
  #sePageEdit .se-family-card{flex-basis:90px!important;width:90px!important;min-width:90px!important;}
  #sePageEdit .se-family-card span{font-size:9px!important;}
  #seModal .se-pile-template-row{grid-template-columns:1fr!important;padding:3px!important;}
  #seModal .se-pile-template-note{font-size:9px;}
  #seModal .se-pile-quick-summary{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:4px!important;}
  #seModal .se-pile-quick-card{min-height:48px!important;padding:5px 6px!important;}
  #seModal .se-pile-section .se-family-row{grid-template-columns:1fr!important;}
  #seModal .se-pile-section .se-family-row.se-pile-compact-row{grid-template-columns:repeat(2,minmax(0,1fr))!important;}
  #seModal .se-pile-section .se-zone-head{display:none!important;}
  #seModal .se-pile-section .se-family-row.se-zone-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 42px!important;grid-template-rows:auto auto!important;gap:4px!important;padding:5px!important;border:1px solid #dbe4ee;border-radius:8px;background:#f8fafc;}
  #seModal .se-pile-section .se-zone-row>td:nth-child(1){grid-column:1;grid-row:1;}
  #seModal .se-pile-section .se-zone-row>td:nth-child(2){grid-column:2;grid-row:1;}
  #seModal .se-pile-section .se-zone-row>td:nth-child(3){grid-column:1;grid-row:2;}
  #seModal .se-pile-section .se-zone-row>td:nth-child(4){grid-column:2;grid-row:2;}
  #seModal .se-pile-section .se-zone-row>td:nth-child(5){grid-column:3;grid-row:1 / span 2;display:grid!important;place-items:center;}
  #seModal .se-pile-section .se-zone-row .se-field-shell .se-input{min-height:36px!important;}
  #seModal .se-pile-section .se-zone-row .se-del-btn{width:40px!important;height:40px!important;}
}

/* A pile cage has four fabrication previews below the main drawing.  On a
   phone that content belongs to the same vertical document flow; reserving a
   fixed preview row makes the following data panel cover the component cards. */
@media(max-width:760px){
  #seModal.se-pile-editor #sePageEdit{display:flex!important;flex-direction:column!important;}
  #seModal.se-pile-editor #sePageEdit .se-family-panel{flex:none!important;}
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{height:auto!important;min-height:max-content!important;overflow:visible!important;flex:none!important;}
  #seModal.se-pile-editor #sePageEdit .se-data-panel{flex:none!important;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{height:300px!important;min-height:300px!important;flex:none!important;}
}

/* Round pile cage — visual-first workspace.  This layer is intentionally
   presentation-only: calculations and saved snapshot fields stay canonical. */
#seModal.se-pile-editor #sePageEdit{
  grid-template-columns:minmax(286px,31%) minmax(0,69%);
  grid-template-rows:minmax(0,1fr);
  gap:0;
  background:#e8ebef;
}
#seModal.se-pile-editor #sePageEdit .se-family-panel{display:none!important;}
#seModal.se-pile-editor #sePageEdit .se-preview-panel{
  order:2;
  min-height:0;
  display:grid;
  grid-template-rows:38px minmax(300px,1fr) auto;
  gap:8px;
  overflow:hidden;
  padding:10px 12px 8px;
  background:#e8ebef;
}
#seModal.se-pile-editor #sePageEdit .se-data-panel{
  order:1;
  min-width:0;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  background:#f5f6f8;
  border-inline-end:1px solid #cbd2dc;
}
#seModal.se-pile-editor .se-canvas-topbar{min-height:38px;height:38px;background:transparent;}
#seModal.se-pile-editor #se3DOrbitCtrl{display:none!important;}
#seModal.se-pile-editor .se-svg-wrap{
  height:auto!important;
  min-height:300px!important;
  max-height:none!important;
  border:1px solid #cbd2dc;
  border-radius:4px;
  background:#fff;
  overflow:hidden;
}
#seModal.se-pile-editor .se-svg-wrap svg{width:100%;height:100%;min-height:0;}
#seModal.se-pile-editor .se-element-name-row,
#seModal.se-pile-editor .se-mode-note{display:none!important;}
#seModal.se-pile-editor .se-data-panel-head{
  flex:0 0 auto;
  min-height:44px;
  padding:8px 12px;
  background:#172033;
  color:#fff;
  border:0;
}
#seModal.se-pile-editor .se-data-panel-head:before{display:none;}
#seModal.se-pile-editor .se-data-panel-head #seItemNumber{color:#dce6f5!important;}
#seModal.se-pile-editor .se-table-wrap{flex:1;min-height:0;overflow-y:auto;padding:8px 10px 14px;background:#f5f6f8;}
#seModal.se-pile-editor .se-family-editor-table{border-spacing:0 6px;}
#seModal.se-pile-editor .se-pile-group-tabs-row td{padding:0!important;border:0!important;background:transparent!important;}
#seModal .se-pile-group-tabs{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:4px;
  padding:0;
  direction:rtl;
}
#seModal .se-pile-group-tab{
  min-width:0;
  min-height:38px;
  border:1px solid #cbd5e1;
  border-radius:5px;
  background:#fff;
  color:#344054;
  font:900 11px/1.1 Heebo,Arial,sans-serif;
  cursor:pointer;
}
#seModal .se-pile-group-tab[aria-selected="true"]{
  border-color:#172033;
  background:#172033;
  color:#fff;
}
#seModal .se-pile-group-tab:focus-visible{outline:3px solid rgba(224,123,57,.36);outline-offset:2px;}
#seModal.se-pile-editor .se-pile-section-row{display:none!important;}
#seModal.se-pile-editor .se-pile-section-row:has(.se-pile-section[open]){display:table-row!important;}
#seModal.se-pile-editor .se-pile-section{border:0;border-radius:0;background:transparent;overflow:visible;}
#seModal.se-pile-editor .se-pile-section>summary{display:none!important;}
#seModal.se-pile-editor .se-pile-section table{border-spacing:0 6px;}
#seModal.se-pile-editor .se-pile-template-row{
  grid-template-columns:1fr;
  gap:4px;
  padding:2px 0 6px;
}
#seModal.se-pile-editor .se-pile-template-note{display:none;}
#seModal .se-pile-name-field{display:grid;gap:3px;padding:2px;}
#seModal .se-pile-name-field label{font-size:10px;font-weight:900;color:#475569;}
#seModal .se-pile-name-field input{
  min-height:36px;
  border:1px solid #cbd5e1;
  border-radius:6px;
  background:#fff;
  padding:4px 8px;
  font:900 13px Heebo,Arial,sans-serif;
  color:#172033;
  text-align:right;
}
#seModal .se-pile-inline-error{
  display:none;
  margin-top:5px;
  border-inline-start:4px solid #c0392b;
  background:#fff1f2;
  color:#9f1239;
  padding:7px 9px;
  font-size:11px;
  font-weight:900;
}
#seModal .se-pile-inline-error:not(:empty){display:block;}
#seModal.se-pile-editor .se-pile-quick-summary,
#seModal.se-pile-editor .se-pile-elements-row,
#seModal.se-pile-editor .se-pile-validation{display:none!important;}
#seModal.se-pile-editor .se-pile-component-gallery{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:6px;
  width:100%;
  padding:0;
  overflow:visible;
}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{
  grid-template-columns:68px minmax(0,1fr);
  min-height:78px;
  padding:5px;
  gap:6px;
  border:1px solid #bec8d5;
  border-inline-start:4px solid #64748b;
  border-radius:5px;
  background:#fff;
  color:#172033;
}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card[aria-pressed="true"]{
  border-color:#172033;
  border-inline-start-color:#e06b22;
  box-shadow:0 0 0 2px rgba(23,32,51,.12);
}
#seModal.se-pile-editor .se-pile-component-visual{width:68px;height:56px;border:0;border-radius:0;}
#seModal.se-pile-editor .se-pile-component-copy{gap:3px;}
#seModal.se-pile-editor .se-pile-component-card-title{font-size:10px;}
#seModal.se-pile-editor .se-pile-component-metrics{grid-template-columns:1fr;gap:1px;}
#seModal.se-pile-editor .se-pile-component-metric{
  border:0;
  border-radius:0;
  background:transparent;
  padding:0;
  font-size:9px;
  text-align:start;
}
#seModal svg.se-focus-mode [data-se-focus]{opacity:.68;transition:opacity .14s,stroke .14s,fill .14s,filter .14s;}
#seModal svg.se-focus-mode [data-se-focus].se-focus-hit{opacity:1!important;filter:drop-shadow(0 0 1px rgba(224,107,34,.3))!important;}
#seModal svg.se-focus-mode [data-se-focus].se-focus-hit:not(text){stroke-width:2.2px;}
#seModal.se-pile-editor .se-foot{height:58px;min-height:58px;padding:7px 12px;}
#seModal.se-pile-editor .se-summary-item{min-width:96px;padding:5px 8px;}
#seModal.se-pile-editor .se-summary-item strong,#seModal.se-pile-editor .se-quantity-input{font-size:15px;}
#seModal.se-pile-editor .se-foot-actions button{min-height:38px;}

/* Round pile cage quick entry.  Every ordinary manufacturing input stays in
   one keyboard-ordered surface; the small navigation rail only scrolls to a
   group and never hides another group. */
#seModal.se-pile-editor #sePageEdit{
  grid-template-columns:minmax(330px,36%) minmax(0,64%);
}
#seModal.se-pile-editor .se-data-panel-head{
  min-height:40px;
  padding:7px 10px;
}
#seModal.se-pile-editor .se-table-wrap{
  padding:6px 8px 12px;
}
#seModal.se-pile-editor .se-family-editor-table{
  border-spacing:0 4px;
}
#seModal.se-pile-editor .se-pile-section-row{
  display:table-row!important;
}
#seModal.se-pile-editor .se-pile-group-tabs{
  position:sticky;
  top:-6px;
  z-index:4;
  padding:4px 0;
  background:#f5f6f8;
}
#seModal.se-pile-editor .se-pile-group-tab{
  min-height:30px;
  font-size:10px;
  border-radius:4px;
}
#seModal.se-pile-editor .se-pile-section-row td{
  padding:0!important;
}
#seModal.se-pile-editor .se-pile-section{
  border-radius:5px;
  overflow:visible;
}
#seModal.se-pile-editor .se-pile-section-head{
  min-height:28px;
  padding:4px 7px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:6px;
  background:#e9eef5;
  border-bottom:1px solid #d6dee8;
  color:#172033;
}
#seModal.se-pile-editor .se-pile-section-head strong{
  font-size:11px;
  font-weight:900;
}
#seModal.se-pile-editor .se-pile-section-head span{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:#64748b;
  font-size:8.5px;
  font-weight:800;
  direction:ltr;
  text-align:left;
}
#seModal.se-pile-editor .se-pile-section table{
  border-spacing:0 2px;
}
#seModal.se-pile-editor .se-pile-name-field{
  display:grid;
  grid-template-columns:58px minmax(0,1fr);
  align-items:center;
  gap:5px;
  padding:2px;
}
#seModal.se-pile-editor .se-pile-name-field label{
  margin:0;
  font-size:9px;
}
#seModal.se-pile-editor .se-pile-name-field input{
  min-height:25px;
  padding:2px 6px;
  border-radius:5px;
}
#seModal.se-pile-editor .se-pile-section .se-family-row{
  gap:3px!important;
}
#seModal.se-pile-editor .se-pile-section .se-field-shell .se-input{
  min-height:24px;
}
#seModal.se-pile-editor .se-zone-row{
  grid-template-columns:minmax(46px,.58fr) minmax(58px,.85fr) minmax(54px,.78fr) minmax(64px,.9fr) 24px!important;
}
#seModal.se-pile-editor .se-pile-action-row td{
  display:flex!important;
  align-items:center;
  justify-content:space-between;
  gap:6px;
}
#seModal.se-pile-editor .se-pile-action-row .se-add-btn{
  width:auto;
  padding-inline:10px;
}
#seModal.se-pile-editor .se-pile-advanced{
  margin:3px 2px 1px;
  border-top:1px dashed #cbd5e1;
}
#seModal.se-pile-editor .se-pile-advanced summary{
  cursor:pointer;
  list-style:none;
  padding:4px 3px 2px;
  color:#64748b;
  font-size:9px;
  font-weight:900;
}
#seModal.se-pile-editor .se-pile-advanced summary::-webkit-details-marker{display:none;}
#seModal.se-pile-editor .se-pile-advanced-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:3px;
  padding:2px;
}
#seModal.se-pile-editor .se-pile-inline-error:empty{display:none;}
#seModal.se-pile-editor .se-pile-inline-error{
  margin:2px;
  padding:5px 7px;
  border:1px solid #fecaca;
  border-radius:4px;
  background:#fff1f2;
  color:#be123c;
  font-size:9px;
  font-weight:900;
}
#seModal.se-pile-editor .se-pile-component-card{
  cursor:default;
}

@media(min-width:761px) and (max-width:1100px){
  #seModal.se-pile-editor #sePageEdit{
    display:grid!important;
    grid-template-columns:1fr!important;
    grid-template-rows:minmax(330px,56dvh) minmax(0,1fr)!important;
    overflow:hidden!important;
  }
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{order:1;min-height:330px;padding:8px 10px;}
  #seModal.se-pile-editor #sePageEdit .se-data-panel{order:2;min-height:0;overflow:hidden;border-top:1px solid #cbd2dc;}
  #seModal.se-pile-editor .se-table-wrap{overflow-y:auto;}
  #seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{min-height:70px;}
}

@media(max-width:760px){
  #seModal.se-pile-editor #sePageEdit{
    display:flex!important;
    flex-direction:column!important;
    overflow-y:auto!important;
    overflow-x:hidden!important;
  }
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{display:contents!important;}
  #seModal.se-pile-editor .se-canvas-topbar{order:1;margin:5px 8px 0;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{
    order:2;
    width:calc(100% - 16px);
    margin:0 8px;
    height:250px!important;
    min-height:250px!important;
    max-height:250px!important;
  }
  #seModal.se-pile-editor .se-pile-component-gallery{
    order:4;
    flex:0 0 auto!important;
    width:calc(100% - 16px);
    margin:0 8px 8px;
    min-height:110px;
    display:grid!important;
    grid-auto-flow:column;
    grid-template-columns:none!important;
    grid-auto-columns:minmax(142px,42vw);
    gap:6px!important;
    overflow-x:auto!important;
    overflow-y:hidden!important;
    scroll-snap-type:x mandatory;
    padding-bottom:5px!important;
  }
  #seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{
    scroll-snap-align:start;
    grid-template-columns:52px minmax(0,1fr)!important;
    min-height:68px!important;
  }
  #seModal.se-pile-editor .se-pile-component-visual{width:52px;height:48px;}
  #seModal.se-pile-editor #sePageEdit .se-data-panel{
    order:3!important;
    width:100%!important;
    min-height:auto!important;
    overflow:visible!important;
  }
  #seModal.se-pile-editor .se-data-panel-head{min-height:38px!important;padding:6px 9px!important;}
  #seModal.se-pile-editor .se-table-wrap{height:auto!important;max-height:none!important;overflow:visible!important;padding:7px 8px 12px!important;}
  #seModal .se-pile-group-tabs{position:sticky;top:0;z-index:4;background:#f5f6f8;padding-block:2px;}
  #seModal .se-pile-group-tab{min-height:36px;font-size:10px;}
  #seModal.se-pile-editor .se-pile-section .se-family-row.se-pile-compact-row{grid-template-columns:repeat(2,minmax(0,1fr))!important;}
  #seModal.se-pile-editor .se-pile-section-head span{max-width:62%;}
  #seModal.se-pile-editor .se-pile-advanced-grid{grid-template-columns:1fr;}
  #seModal.se-pile-editor .se-foot{min-height:94px!important;height:auto!important;}
}

@media(max-width:420px){
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{grid-template-rows:28px 236px auto!important;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{height:236px!important;min-height:236px!important;max-height:236px!important;}
  #seModal.se-pile-editor .se-pile-component-gallery{grid-auto-columns:148px;}
  #seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{padding:4px;}
  #seModal.se-pile-editor .se-pile-section .se-family-row.se-pile-compact-row{grid-template-columns:repeat(2,minmax(0,1fr))!important;}
}

/* Professional Quick Entry V2: drawing + engineering grid.  This final layer
   changes layout only; every control still writes the existing canonical cage
   fields and every component visual still comes from its standalone engine. */
@media(min-width:1101px){
  #seModal.se-pile-editor #sePageEdit{
    display:grid!important;
    grid-template-columns:1fr!important;
    grid-template-rows:34px minmax(300px,42vh) auto auto!important;
    overflow-y:auto!important;
    overflow-x:hidden!important;
    background:#eef1f4;
  }
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{display:contents!important;}
  #seModal.se-pile-editor .se-canvas-topbar{grid-row:1;grid-column:1;margin:4px 12px 0;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{
    grid-row:2;grid-column:1;
    width:calc(100% - 24px);
    margin:0 12px;
    height:auto!important;
    min-height:300px!important;
    max-height:none!important;
  }
  #seModal.se-pile-editor #sePageEdit .se-data-panel{
    grid-row:3;grid-column:1;
    width:100%!important;
    height:max-content!important;
    min-height:max-content!important;
    overflow:visible!important;
    border:0;
    border-top:1px solid #cbd5e1;
  }
  #seModal.se-pile-editor .se-data-panel-head{display:none!important;}
  #seModal.se-pile-editor .se-table-wrap{flex:none!important;height:auto!important;overflow:visible!important;padding:7px 12px 5px!important;}
  #seModal.se-pile-editor .se-pile-component-gallery{
    grid-row:4;grid-column:1;
    width:calc(100% - 24px);
    margin:2px 12px 10px;
  }
}

#seModal.se-pile-editor .se-family-editor-table,
#seModal.se-pile-editor .se-family-editor-table tbody{width:100%;}
#seModal.se-pile-editor .se-pile-engineering-grid-row,
#seModal.se-pile-editor .se-pile-engineering-grid-row>td{display:block!important;width:100%!important;padding:0!important;}
#seModal.se-pile-editor .se-pile-engineering-grid{
  display:grid;
  grid-template-columns:minmax(175px,.8fr) minmax(270px,1.25fr) minmax(330px,1.45fr) minmax(235px,1fr);
  gap:7px;
  align-items:stretch;
  direction:rtl;
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-pile-section{
  min-width:0;
  border:1px solid #cbd5e1;
  border-radius:7px;
  background:#fff;
  overflow:hidden;
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-pile-section[data-active="true"]{
  border-color:#64748b;
  box-shadow:0 0 0 1px rgba(100,116,139,.16);
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-pile-section-head{
  min-height:26px;
  padding:4px 7px;
  background:#e9eef5;
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-pile-section-head strong{font-size:11px;}
#seModal.se-pile-editor .se-pile-engineering-grid .se-pile-section-head span{display:none;}
#seModal.se-pile-editor .se-pile-section-body{padding:5px;}
#seModal.se-pile-editor .se-pile-identity-grid,
#seModal.se-pile-editor .se-pile-bars-grid,
#seModal.se-pile-editor .se-pile-spiral-head,
#seModal.se-pile-editor .se-pile-hoops-grid{display:grid;gap:4px;align-items:end;}
#seModal.se-pile-editor .se-pile-identity-grid{grid-template-columns:minmax(64px,.8fr) repeat(2,minmax(68px,1fr));}
#seModal.se-pile-editor .se-pile-bars-grid{grid-template-columns:repeat(4,minmax(58px,1fr));}
#seModal.se-pile-editor .se-pile-spiral-head{grid-template-columns:repeat(2,minmax(72px,1fr)) auto;margin-bottom:5px;}
#seModal.se-pile-editor .se-pile-hoops-grid{grid-template-columns:repeat(3,minmax(64px,1fr));}
#seModal.se-pile-editor .se-pile-engineering-grid .se-field-shell{
  grid-template-columns:minmax(0,1fr)!important;
  grid-template-areas:'label' 'input'!important;
  gap:1px!important;
  min-width:0;
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-param-label{
  justify-self:center;
  max-width:100%;
  font-size:8px;
  text-align:center;
}
#seModal.se-pile-editor .se-pile-engineering-grid .se-param-unit,
#seModal.se-pile-editor .se-pile-engineering-grid .se-param-example{display:none!important;}
#seModal.se-pile-editor .se-pile-engineering-grid .se-field-shell .se-input{
  min-height:26px!important;
  padding:1px 4px!important;
  border-radius:5px;
  font-size:12px!important;
}
#seModal.se-pile-editor .se-pile-name-field{
  display:grid!important;
  grid-template-columns:1fr!important;
  gap:1px!important;
  padding:0!important;
}
#seModal.se-pile-editor .se-pile-name-field label{font-size:8px;text-align:center;}
#seModal.se-pile-editor .se-pile-name-field input{min-height:26px!important;padding:1px 4px!important;text-align:center;direction:ltr;}
#seModal.se-pile-editor .se-zone-engineering-grid{display:grid;gap:3px;}
#seModal.se-pile-editor .se-zone-engineering-row{
  display:grid;
  grid-template-columns:minmax(38px,.52fr) minmax(58px,.8fr) minmax(54px,.72fr) minmax(78px,1fr) 24px;
  gap:3px;
  align-items:end;
  direction:rtl;
}
#seModal.se-pile-editor .se-zone-engineering-row label{display:grid;gap:1px;min-width:0;color:#475569;font-size:8px;font-weight:900;text-align:center;}
#seModal.se-pile-editor .se-zone-engineering-row label>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#seModal.se-pile-editor .se-zone-engineering-row small{font-size:7px;color:#64748b;}
#seModal.se-pile-editor .se-zone-engineering-row .se-input{width:100%;min-width:0;min-height:25px;padding:1px 3px;border:1px solid #cbd4df;border-radius:5px;background:#f8fafc;font:900 11px Arial;text-align:center;direction:ltr;}
#seModal.se-pile-editor .se-zone-engineering-row .se-input:focus{border-color:#ff4047;box-shadow:0 0 0 2px rgba(255,64,71,.12);background:#fff;outline:0;}
#seModal.se-pile-editor .se-zone-engineering-row .se-input:disabled{opacity:.38;}
#seModal.se-pile-editor .se-zone-nowrap{display:flex!important;min-height:25px;align-items:center;justify-content:center;gap:4px;border:1px solid #cbd4df;border-radius:5px;background:#f8fafc;}
#seModal.se-pile-editor .se-zone-nowrap input{width:15px;height:15px;margin:0;}
#seModal.se-pile-editor .se-zone-engineering-row .se-del-btn{width:24px;height:25px;margin:0;}
#seModal.se-pile-editor .se-zone-add{width:auto;min-height:25px;margin-top:4px;padding:2px 9px;font-size:9px;}
#seModal.se-pile-editor .se-pile-spiral-head .se-derived-chip{align-self:end;min-height:26px;padding:5px 6px;white-space:nowrap;}
#seModal.se-pile-editor .se-pile-advanced{margin-top:4px;border-top:1px dashed #cbd5e1;}
#seModal.se-pile-editor .se-pile-advanced summary{width:28px;margin-inline-start:auto;padding:1px 5px;font-size:12px;text-align:center;}
#seModal.se-pile-editor .se-pile-advanced-grid{padding:3px 0 0;}
#seModal.se-pile-editor .se-pile-template-row label{font-size:8px;}
#seModal.se-pile-editor .se-pile-template-row select{min-height:25px;}
#seModal.se-pile-editor .se-pile-inline-error{margin:3px 0 0;padding:4px 5px;font-size:8px;}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{
  grid-template-columns:96px minmax(0,1fr)!important;
  min-height:118px!important;
  padding:7px!important;
  gap:8px!important;
}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-visual{width:96px;height:92px;}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card-title{font-size:12px;}
#seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-metric{font-size:10.5px;line-height:1.25;}

@media(min-width:761px) and (max-width:1100px){
  #seModal.se-pile-editor #sePageEdit{display:flex!important;flex-direction:column!important;overflow-y:auto!important;}
  #seModal.se-pile-editor #sePageEdit .se-preview-panel{display:contents!important;}
  #seModal.se-pile-editor .se-canvas-topbar{order:1;margin:4px 10px 0;}
  #seModal.se-pile-editor #sePageEdit .se-svg-wrap{order:2;width:calc(100% - 20px);margin:0 10px;height:330px!important;min-height:330px!important;}
  #seModal.se-pile-editor #sePageEdit .se-data-panel{order:3;flex:0 0 auto!important;width:100%!important;overflow:visible!important;min-height:max-content!important;}
  #seModal.se-pile-editor .se-data-panel-head{display:none!important;}
  #seModal.se-pile-editor .se-table-wrap{height:auto!important;overflow:visible!important;padding:7px 10px!important;}
  #seModal.se-pile-editor .se-pile-engineering-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  #seModal.se-pile-editor .se-pile-component-gallery{order:4;flex:0 0 auto!important;width:calc(100% - 20px);min-height:110px;margin:0 10px 10px;}
}

@media(max-width:760px){
  #seModal.se-pile-editor #sePageEdit .se-data-panel{flex:0 0 auto!important;min-height:max-content!important;}
  #seModal.se-pile-editor .se-data-panel-head{display:none!important;}
  #seModal.se-pile-editor .se-family-editor-table,
  #seModal.se-pile-editor .se-family-editor-table tbody{display:block!important;height:auto!important;}
  #seModal.se-pile-editor .se-pile-engineering-grid-row{height:auto!important;}
  #seModal.se-pile-editor .se-pile-engineering-grid{grid-template-columns:1fr;gap:6px;}
  #seModal.se-pile-editor .se-pile-bars-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  #seModal.se-pile-editor .se-pile-hoops-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  #seModal.se-pile-editor .se-pile-component-gallery{flex:0 0 auto!important;min-height:110px;grid-auto-columns:minmax(210px,72vw)!important;}
  #seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-card{grid-template-columns:82px minmax(0,1fr)!important;min-height:100px!important;}
  #seModal.se-pile-editor .se-pile-component-gallery .se-pile-component-visual{width:82px;height:78px;}
}

@media(max-width:420px){
  #seModal.se-pile-editor .se-pile-group-tabs{position:static;}
  #seModal.se-pile-editor .se-pile-identity-grid{grid-template-columns:repeat(3,minmax(0,1fr));}
  #seModal.se-pile-editor .se-zone-engineering-row{grid-template-columns:38px 56px 52px minmax(76px,1fr) 24px;}
}

</style>
<div id="seModal">
  <!-- ── Header ── -->
  <div class="se-head">
    <div class="se-head-actions">
      <button class="se-close" id="seClose" title="סגור">&times;</button>
      <button class="se-back-btn" id="seBackBtn" style="display:none;">חזרה</button>
    </div>
    <div class="se-head-center">
      <h2 id="seHeadTitle">בחר צורה</h2>
      <span class="se-step-indicator" id="seStepIndicator">שלב 1 מתוך 3</span>
    </div>
    <div class="se-brand"><img src="/brand/tene-pdf-logo.jpg" alt="טנא תעשיות ברזל"></div>
  </div>

  <!-- PAGE 0: Segment count picker -->
  <div id="sePageCount" style="flex:1;overflow-y:auto;background:#f4f6f9;display:flex;align-items:center;justify-content:center;">
    <div style="text-align:center;padding:40px 20px;">
      <div style="font-size:20px;font-weight:900;color:#1a2332;margin-bottom:8px;">כמה צלעות יש לצורה?</div>
      <div style="font-size:13px;color:#7a93ab;margin-bottom:36px;">בחר ויוצגו כל הצורות המתאימות</div>
      <div id="seCountBtns" style="display:flex;flex-wrap:wrap;justify-content:center;gap:14px;max-width:700px;"></div>
    </div>
  </div>

  <!-- ── PAGE 1: Shape selection ── -->
  <div id="sePageSelect" style="display:none;flex:1;overflow-y:auto;background:#f4f6f9;">
    <div id="seFamilyTabs"></div>
    <div id="seCategoryFilters"></div>
    <div id="seSideFilters"></div>
    <div id="seSavedSection"></div>
    <div style="padding:10px 24px 12px;font-size:15px;font-weight:900;color:#243047;" id="sePresetsTitle">סינון צורות</div>
    <div id="sePresets" style="padding:0 24px 20px;display:grid;grid-template-columns:repeat(5,1fr);gap:10px;"></div>
  </div>

  <!-- ── PAGE 2: Dimension editing (hidden initially) ── -->
  <div id="sePageEdit" style="display:none;">
    <aside class="se-family-panel" aria-label="בחירת משפחת צורה">
      <div class="se-family-panel-title">סוג צורה</div>
      <button class="se-family-card" data-edit-family="bars" onclick="window._seEditor._jumpToFamily('bars')">${shapePresetIconSVG('straight')}<span>מוטות ברזל</span></button>
      <button class="se-family-card" data-edit-family="rounded" onclick="window._seEditor._jumpToFamily('rounded')">${shapePresetIconSVG('rounded-u')}<span>קצה מעוגל</span></button>
      <button class="se-family-card" data-edit-family="mesh" onclick="window._seEditor._jumpToFamily('mesh')">${shapePresetIconSVG('mesh')}<span>רשתות</span></button>
      <button class="se-family-card" data-edit-family="piles" onclick="window._seEditor._jumpToFamily('piles')">${shapePresetIconSVG('pile')}<span>כלונסאות</span></button>
      <button class="se-family-card" data-edit-family="spirals" onclick="window._seEditor._jumpToFamily('spirals')">${shapePresetIconSVG('spiral')}<span>ספיראלות</span></button>
      <button class="se-family-card" data-edit-family="lifts" onclick="window._seEditor._jumpToFamily('lifts')">${liftPresetIconSVG()}<span>ליפטים</span></button>
      <button class="se-family-card" data-edit-family="ring" onclick="window._seEditor._jumpToFamily('ring')">${shapePresetIconSVG('ring')}<span>טבעות</span></button>
      <button class="se-family-card" data-edit-family="bench" onclick="window._seEditor._jumpToFamily('bench')">${shapePresetIconSVG('bench')}<span>ספסל</span></button>
      <div id="seSidebarSaved" style="margin-top:8px;border-top:1px solid #c5cbd4;padding-top:10px;"></div>
    </aside>
    <!-- Center: preview -->
    <div class="se-preview-panel">
      <!-- View toggle -->
      <div class="se-canvas-topbar" style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <div id="se3DOrbitCtrl" style="flex-shrink:0;display:flex;align-items:center;gap:3px;padding:4px 6px;background:#f0f4f8;border-radius:8px;border:1px solid #e2e8ef;">
          <span style="font-size:10px;color:#7a93ab;font-weight:700;margin-left:2px;">תצוגה:</span>
          <button class="se-rot-btn" title="שמאלה" style="width:26px;height:26px;font-size:12px;" onclick="if(window._seEditor){window._seEditor._camTheta-=Math.PI/8;window._seEditor._updatePreview();}">◁</button>
          <button class="se-rot-btn" title="למעלה" style="width:26px;height:26px;font-size:12px;" onclick="if(window._seEditor){window._seEditor._camPhi=Math.min(Math.PI/2-0.05,window._seEditor._camPhi+Math.PI/8);window._seEditor._updatePreview();}">△</button>
          <button class="se-rot-btn" title="איפוס" style="width:26px;height:26px;font-size:12px;" onclick="if(window._seEditor){window._seEditor._camTheta=Math.PI/4;window._seEditor._camPhi=Math.PI/4;window._seEditor._updatePreview();}">⊙</button>
          <button class="se-rot-btn" title="למטה" style="width:26px;height:26px;font-size:12px;" onclick="if(window._seEditor){window._seEditor._camPhi=Math.max(-Math.PI/2+0.05,window._seEditor._camPhi-Math.PI/8);window._seEditor._updatePreview();}">▽</button>
          <button class="se-rot-btn" title="ימינה" style="width:26px;height:26px;font-size:12px;" onclick="if(window._seEditor){window._seEditor._camTheta+=Math.PI/8;window._seEditor._updatePreview();}">▷</button>
          <div style="width:1px;height:20px;background:#d0d8e4;margin:0 3px;"></div>
          <span style="font-size:10px;color:#7a93ab;font-weight:700;">זום:</span>
          <button class="se-rot-btn" title="הקטן" style="width:26px;height:26px;font-size:15px;font-weight:700;" onclick="if(window._seEditor)window._seEditor._setZoom(-0.15)">−</button>
          <span id="seZoomVal" style="font-size:10px;color:#7a93ab;min-width:32px;text-align:center;font-weight:700;">100%</span>
          <button class="se-rot-btn" title="הגדל" style="width:26px;height:26px;font-size:15px;font-weight:700;" onclick="if(window._seEditor)window._seEditor._setZoom(+0.15)">+</button>
          <button class="se-rot-btn" title="איפוס זום" style="width:26px;height:26px;font-size:10px;" onclick="if(window._seEditor)window._seEditor._setZoom(0,true)">1:1</button>
        </div>
        <div class="se-view-controls">
          <span class="se-view-label">מצב שרטוט</span>
          <button id="seView2D" onclick="seSetView('2d')" style="padding:5px 14px;border-radius:6px;border:1.5px solid #e07b39;background:rgba(224,123,57,0.1);color:#e07b39;font-family:'Heebo',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s">2D</button>
          <button id="seView3D" onclick="seSetView('3d')" style="padding:5px 14px;border-radius:6px;border:1.5px solid #d8e2ec;background:#f4f6f9;color:#526070;font-family:'Heebo',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s">3D</button>
          <button id="seResetCam" onclick="if(window._seEditor){window._seEditor._camTheta=Math.PI/4;window._seEditor._camPhi=Math.PI/4;window._seEditor._updatePreview();}" style="padding:5px 9px;border-radius:6px;border:1.5px solid #d8e2ec;background:#f4f6f9;color:#7a93ab;cursor:pointer;font-size:13px;transition:all .15s" title="איפוס זווית">↻</button>
          <button id="seRotateShape" onclick="seRotateShape90()" style="padding:5px 9px;border-radius:6px;border:1.5px solid #d8e2ec;background:#f4f6f9;color:#526070;cursor:pointer;font-size:12px;font-weight:900;transition:all .15s" title="סובב צורה 90 מעלות" aria-label="סובב צורה 90 מעלות" aria-pressed="false">90°</button>
        </div>
      </div>
      <!-- SVG preview -->
      <div class="se-svg-wrap" id="seSvgWrap">
        <svg id="seShapeSvg" viewBox="0 0 300 290" preserveAspectRatio="xMidYMid meet"></svg>
      </div>
      <div class="se-pile-component-gallery" id="sePileComponentGallery" hidden aria-label="רכיבי הכלוב"></div>
    </div>
    <!-- Right: dimension table -->
    <div class="se-data-panel">
      <div class="se-data-panel-head" style="display:flex;justify-content:space-between;align-items:center;">
        <span id="seDataPanelTitle">מידות צלעות וזוויות</span>
        <span id="seItemNumber" style="color:#c9621a;font-weight:900;font-size:12px;"></span>
      </div>
      <div class="se-element-name-row" style="padding:10px 14px;border-bottom:1px solid #e2e8ef;">
        <label for="seElementName" style="display:block;font-size:11px;font-weight:800;color:#7a93ab;letter-spacing:.3px;margin-bottom:5px">שם הפריט (אלמנט)</label>
        <input id="seElementName" class="se-input" type="text" placeholder="קורה / קומה / ציר" autocomplete="off" style="width:100%;box-sizing:border-box;text-align:right" oninput="window._seEditor._setElementName(this.value)">
      </div>
      <div class="se-mode-note">
        <label class="se-3d-toggle">
          <span>
            <strong>מוצר תלת-ממדי אמיתי</strong>
            <small>כבה: 3D הוא רק תצוגה. דלוק: נשמרים נתוני XYZ לפריט.</small>
          </span>
          <span class="se-switch">
            <input type="checkbox" id="seReal3DToggle" onchange="window._seEditor._setReal3D(this.checked)">
            <span class="se-slider"></span>
          </span>
        </label>
        <div class="se-3d-help" id="se3DHelp">תצוגת 3D לא הופכת את המוצר לתלת-ממדי. סמן כאן רק אם הברזל באמת יוצא מהמישור.</div>
      </div>
      <div class="se-panel-summary" aria-live="polite">
        <div class="se-panel-summary-item se-panel-summary-main">
          <span>סה״כ אורך</span>
          <div>
            <strong id="sePanelTotalMm">0</strong>
            <small>ס״מ</small>
          </div>
        </div>
        <div class="se-panel-summary-item">
          <span>אורך בר</span>
          <div>
            <strong id="sePanelTotalM">0.00</strong>
            <small>ס״מ</small>
          </div>
        </div>
        <div class="se-panel-summary-item">
          <span>כיפופים</span>
          <strong id="sePanelBends">0</strong>
        </div>
      </div>
      <div class="se-table-wrap">
        <table class="se-table">
          <thead id="seTableHead">
            <tr>
              <th style="width:32px">#</th>
              <th>אורך (ס"מ)</th>
              <th>זווית כיפוף</th>
              <th style="width:32px"></th>
            </tr>
          </thead>
          <tbody id="seTableBody"></tbody>
        </table>
        <div class="se-add-row" style="padding:10px 14px 6px;">
          <button class="se-add-btn" id="seAddSide">➕ הוסף צלע</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Footer (only visible on page 2) ── -->
  <div class="se-foot" id="seFoot" style="display:none;">
    <!-- Normal footer -->
    <div id="seFootNormal" style="display:flex;width:100%;justify-content:space-between;gap:12px;align-items:center;">
      <div class="se-bottom-summary" aria-live="polite">
        <div class="se-summary-item primary"><span>סה״כ אורך</span><div><strong id="sePerimeter">0</strong><small>ס״מ</small></div></div>
        <div class="se-summary-item"><span>אורך בס״מ</span><div><strong id="seBarLength">0</strong><small>ס״מ</small></div></div>
        <div class="se-summary-item"><span>משקל מחושב</span><div><strong id="seTotalWeight">0.00</strong><small>ק״ג</small></div></div>
        <div class="se-summary-item se-quantity-item" style="display:none"><span>כמות</span><div><input id="seQuantityInput" class="se-quantity-input" type="number" min="1" step="1" value="1" onfocus="this.select()" oninput="window._seEditor?._setQuantity(this.value)"><small>יח׳</small></div></div>
        <div class="se-summary-item" id="seDiameterItem" style="display:none"><span>קוטר</span><div><select id="seDiameterSelect" class="se-quantity-input" onchange="window._seEditor?._setDiameter(this.value)"><option value="0">—</option>${[5.5,6,8,'8|smooth',10,'10|smooth',12,14,16,18,20,22,25,28,32,36,40].map(option => { const smooth = String(option).endsWith('|smooth'); const d = String(option).replace('|smooth',''); return `<option value="${option}">${d}${smooth ? ' חלק' : ''}</option>`; }).join('')}</select><small>מ״מ</small></div></div>
        <div class="se-summary-item" id="seRadiusItem" style="display:none"><span>רדיוס כיפוף</span><div><input id="seRadiusInput" class="se-quantity-input" type="number" min="0" step="0.1" placeholder="אוטומטי" onfocus="this.select()" oninput="window._seEditor?._setBendRadius(this.value)"><small>ס״מ</small></div></div>
        <div class="se-summary-item"><span>כיפופים</span><strong id="seBends">0</strong></div>
      </div>
      <div class="se-foot-actions">
        <button class="se-cancel-btn" id="seCancel">ביטול</button>
        <button class="se-save-shape-btn" id="seSaveShapeBtn">שמור צורה</button>
        <button class="se-ok-btn" id="seOk">אשר צורה</button>
      </div>
    </div>
    <!-- Save bar (hidden by default) -->
    <div id="seFootSave" style="display:none;width:100%;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:13px;font-weight:700;color:#1a2332;font-family:Heebo,sans-serif;white-space:nowrap;">שם הצורה:</span>
      <input id="seSaveNameInput" class="se-input" style="flex:1;min-width:180px;max-width:300px;"
        placeholder="לדוגמה: U-אנקר מיוחד 600מ&quot;מ"
        onkeydown="if(event.key==='Enter')window._seEditor._doSave();if(event.key==='Escape')window._seEditor._hideSaveBar();">
      <button class="se-ok-btn" onclick="window._seEditor._doSave()" style="padding:8px 22px;">שמור ✓</button>
      <button class="se-cancel-btn" onclick="window._seEditor._hideSaveBar()">ביטול</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(overlay);
    this._el = overlay;
    this._bindEvents();
  }

  _bindEvents() {
    document.getElementById('seClose').onclick         = () => this.close();
    document.getElementById('seCancel').onclick        = () => this.close();
    document.getElementById('seOk').onclick            = () => this._confirm();
    document.getElementById('seAddSide').onclick       = () => this._addSide();
    document.getElementById('seSaveShapeBtn').onclick  = () => this._showSaveBar();
    document.getElementById('seBackBtn').onclick = () => this._goBack();
    // Phone taps synthesize extra mouse events right after the tap; they can
    // land on the backdrop while the modal is still sliding in and close the
    // editor instantly. Close only when the press actually started on the
    // backdrop and the open animation has settled.
    this._el.addEventListener('pointerdown', e => { this._backdropPress = e.target === this._el; });
    this._el.addEventListener('click', e => {
      if (e.target === this._el && this._backdropPress && Date.now() - (this._openedAt || 0) > 400) this.close();
      this._backdropPress = false;
    });
    // Keyboard-only shape entry (delegated; survives side-row rebuilds).
    this._el.addEventListener('keydown', e => this._handleShapeKbd(e));
    this._bindDragRotation();
    this._bindWheelZoom();
    this._initShapeTooltip();
  }

  _initShapeTooltip() {
    if (document.getElementById('seShapeTooltip')) return;
    const tip = document.createElement('div');
    tip.id = 'seShapeTooltip';
    document.body.appendChild(tip);
    let hideTimer = null;
    const showTip = (btn, e) => {
      clearTimeout(hideTimer);
      const svgContent = this._tooltipSvgForBtn(btn);
      if (!svgContent) return;
      const name = btn.title || btn.getAttribute('aria-label') || '';
      tip.innerHTML = `<svg viewBox="0 0 200 140" width="200" height="140">${svgContent}</svg><div class="se-tip-name">${name}</div>`;
      tip.style.display = 'flex';
      this._positionTip(tip, e);
    };
    const hideTip = () => { hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 80); };
    document.getElementById('sePageSelect').addEventListener('mouseover', e => {
      const btn = e.target.closest('.se-preset-btn');
      if (btn) showTip(btn, e);
    });
    document.getElementById('sePageSelect').addEventListener('mousemove', e => {
      if (tip.style.display === 'flex') this._positionTip(tip, e);
    });
    document.getElementById('sePageSelect').addEventListener('mouseout', e => {
      const btn = e.target.closest('.se-preset-btn');
      if (btn) hideTip();
    });
    document.getElementById('sePageSelect').addEventListener('click', () => { tip.style.display = 'none'; });
  }

  _positionTip(tip, e) {
    const margin = 16;
    let x = e.clientX + 18;
    let y = e.clientY - 80;
    if (x + 224 > window.innerWidth)  x = e.clientX - 224 - margin;
    if (y < margin)                    y = margin;
    if (y + 200 > window.innerHeight)  y = window.innerHeight - 200 - margin;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  }

  _tooltipSvgForBtn(btn) {
    const savedId  = btn.dataset.savedId;
    const presetId = btn.dataset.id;
    if (savedId) {
      const saved = loadSavedShapes().find(s => s.id === savedId);
      if (!saved) return null;
      const sf = saved.family || 'bars';
      if (sf === 'spirals') return ShapeEngineRouter.render(saved, 200, 140);
      if (sf === 'mesh')    return MeshEngine.render(saved, 200, 140);
      if (sf === 'piles')   return PileCageEngine.render(saved, 200, 140);
      return shape3DSVG(saved.sides || [], saved.angles || [], 200, 140, 12, { showAxes: false, showDims: false });
    }
    if (presetId) {
      const preset = SHAPE_PRESETS.find(s => s.id === presetId);
      if (!preset) return null;
      const fam = preset.family || 'bars';
      if (isRoundedEndBarShape(preset)) return roundedEndBarEditorSVG(preset.sides || [], 200, 140, { radiusMm: preset.radiusMm });
      if (fam === 'spirals') return ShapeEngineRouter.render(preset, 200, 140);
      if (fam === 'mesh')    return MeshEngine.render(preset, 200, 140);
      if (fam === 'piles')   return PileCageEngine.render(preset, 200, 140);
      return shape3DSVG(preset.sides || [], preset.angles || [], 200, 140, preset.diameter || 12, { showAxes: false, showDims: false });
    }
    return null;
  }

  _goToCount() {
    this._currentPage = 'count';
    document.getElementById('sePageCount').style.display  = '';
    document.getElementById('sePageSelect').style.display = 'none';
    document.getElementById('sePageEdit').style.display   = 'none';
    document.getElementById('seFoot').style.display       = 'none';
    document.getElementById('seBackBtn').style.display    = 'none';
    document.getElementById('seHeadTitle').textContent    = 'בחר צורה';
    const step = document.getElementById('seStepIndicator'); if (step) step.textContent = 'שלב 1 מתוך 3';
    this._renderCountPicker();
  }

  _renderCountPicker() {
    const counts = {};
    SHAPE_PRESETS.forEach(s => {
      const n = s.sides.length;
      counts[n] = (counts[n] || 0) + 1;
    });
    const cont = document.getElementById('seCountBtns');
    cont.innerHTML = Object.entries(counts)
      .sort(([a],[b]) => Number(a)-Number(b))
      .map(([n, total]) => {
        const shapeName = COUNT_PICKER_NAMES[Number(n)] || n + ' צלעות';
        return '<button class="se-count-btn" data-count="'+n+'">'
          + countPickerShapeSVG(n)
          + '<div class="cnt-num">'+n+'</div>'
          + '<div class="cnt-name">'+shapeName+'</div>'
          + '<div class="cnt-lbl">צלעות</div>'
          + '</button>';
      }).join('');
    cont.querySelectorAll('.se-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._selectedCount = parseInt(btn.dataset.count);
        this._goToSelect();
      });
    });
  }

  _bindWheelZoom() {
    const wrap = document.getElementById('seSvgWrap');
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._setZoom(e.deltaY < 0 ? 0.1 : -0.1);
    }, { passive: false });
  }

  _setZoom(delta, reset = false) {
    this._zoom = reset ? 1 : Math.min(4, Math.max(0.3, (this._zoom || 1) + delta));
    const svg = document.getElementById('seShapeSvg');
    if (svg) {
      svg.style.transform = `scale(${this._zoom})`;
      svg.style.transformOrigin = 'center center';
    }
    const lbl = document.getElementById('seZoomVal');
    if (lbl) lbl.textContent = Math.round(this._zoom * 100) + '%';
  }

  _defaultPresetForFamily(family = 'bars') {
    if (family === 'ring') return SHAPE_PRESETS.find(isStandaloneRingShape) || SHAPE_PRESETS[0];
    if (family === 'bench') return SHAPE_PRESETS.find(isBenchBarShape) || SHAPE_PRESETS[0];
    if (family === 'rounded') return SHAPE_PRESETS.find(isRoundedEndBarShape) || SHAPE_PRESETS[0];
    const normalizedFamily = (family === 'mesh' || family === 'piles' || family === 'spirals' || family === 'lifts') ? family : 'bars';
    const requestedSideCount = Number(this._selectedCount || this._selectedSideCount);
    const candidates = SHAPE_PRESETS.filter(shape => (shape.family || 'bars') === normalizedFamily && !shape.custom && (normalizedFamily !== 'spirals' || !isStandaloneRingShape(shape)));
    if (normalizedFamily === 'bars' && Number.isFinite(requestedSideCount) && requestedSideCount > 0) {
      const bySideCount = candidates.find(shape => Array.isArray(shape.sides) && shape.sides.length === requestedSideCount);
      if (bySideCount) return bySideCount;
    }
    return candidates[0] || SHAPE_PRESETS.find(shape => (shape.family || 'bars') === normalizedFamily) || SHAPE_PRESETS[0];
  }

  _startDefaultEdit(family = 'bars') {
    this._selectedFamily = family === 'ring' ? 'spirals' : ((family === 'mesh' || family === 'piles' || family === 'spirals' || family === 'lifts') ? family : 'bars');
    this._selectedCategory = '';
    if (this._selectedSideCount === undefined) this._selectedSideCount = this._selectedCount || null;
    const preset = this._defaultPresetForFamily(family);
    if (preset) this._loadPreset(preset);
  }

  _goToSelect() {
    this._startDefaultEdit(this._selectedFamily || 'bars');
    return;
    this._currentPage = 'select';
    document.getElementById('sePageCount').style.display  = 'none';
    document.getElementById('sePageSelect').style.display = '';
    document.getElementById('sePageEdit').style.display   = 'none';
    document.getElementById('seFoot').style.display       = 'none';
    document.getElementById('seBackBtn').style.display    = '';
    document.getElementById('seHeadTitle').textContent    = 'בחר צורה';
    const step = document.getElementById('seStepIndicator'); if (step) step.textContent = 'שלב 2 מתוך 3';
    this._renderFamilyTabs();
    this._renderCategoryFilters();
    this._renderSideFilters();
    this._renderSavedShapes(this._selectedCount);
    this._renderPresets(this._selectedCount);
  }

  _goBack() {
    this.close();
  }

  _renderFamilyTabs() {
    const cont = document.getElementById('seFamilyTabs');
    if (!cont) return;
    cont.innerHTML = SHAPE_FAMILIES.map(f => `<button class="se-family-tab ${this._selectedFamily === f.id ? 'active' : ''}" data-family="${f.id}">${f.label}</button>`).join('');
    cont.querySelectorAll('[data-family]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._selectedFamily = btn.dataset.family;
        this._selectedCategory = 'הכל';
        this._selectedSideCount = 'הכל';
        this._renderFamilyTabs();
        this._renderCategoryFilters();
        this._renderSideFilters();
        this._renderSavedShapes(this._selectedCount);
        this._renderPresets(this._selectedCount);
      });
    });
  }

  _renderCategoryFilters() {
    const cont = document.getElementById('seCategoryFilters');
    if (!cont) return;
    const isBars = (this._selectedFamily || 'bars') === 'bars';
    cont.style.display = isBars ? 'flex' : 'none';
    if (!isBars) return;
    cont.innerHTML = SHAPE_CATEGORY_FILTERS.map(label => `<button class="se-category-filter ${this._selectedCategory === label ? 'active' : ''}" data-category="${label}">${label}</button>`).join('');
    cont.querySelectorAll('[data-category]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._selectedCategory = btn.dataset.category;
        this._renderCategoryFilters();
        this._renderPresets(this._selectedCount);
      });
    });
  }

  _renderSideFilters() {
    const cont = document.getElementById('seSideFilters');
    if (!cont) return;
    const isBars = (this._selectedFamily || 'bars') === 'bars';
    cont.style.display = isBars ? 'flex' : 'none';
    if (!isBars) return;
    const selected = this._selectedSideCount === undefined ? 'הכל' : this._selectedSideCount;
    cont.innerHTML = SHAPE_SIDE_FILTERS.map(value => {
      const label = value === 'הכל' ? 'הכל' : `${value}`;
      return `<button class="se-side-filter ${String(selected) === String(value) ? 'active' : ''}" data-side-count="${value}">${label}</button>`;
    }).join('');
    cont.querySelectorAll('[data-side-count]').forEach(btn => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.sideCount;
        this._selectedSideCount = raw === 'הכל' ? 'הכל' : Number(raw);
        this._renderSideFilters();
        this._renderSavedShapes(this._selectedCount);
        this._renderPresets(this._selectedCount);
      });
    });
  }

  _goToEdit() {
    this._currentPage = 'edit';
    this._activeSeg = null; // clear selection when entering edit page
    if (this.current?.roundPileCage) this._activePileSection = 'general';
    document.getElementById('sePageCount').style.display  = 'none';
    document.getElementById('sePageSelect').style.display = 'none';
    document.getElementById('sePageEdit').style.display   = '';
    document.getElementById('seFoot').style.display       = '';
    document.getElementById('seBackBtn').style.display    = '';
    const name = this.current?.presetName || 'עריכת צורה';
    document.getElementById('seHeadTitle').textContent    = name;
    const step = document.getElementById('seStepIndicator'); if (step) step.textContent = 'שלב 3 מתוך 3';
    this._syncEditFamilyCards();
    this._renderTable();
    this._updatePreview();
  }

  _bindDragRotation() {
    const wrap = document.getElementById('seSvgWrap');
    let drag = null; // { pointerId, startX, startY, startTheta, startPhi }

    const startDrag = e => {
      if (window._seViewMode === '2d') return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, theta: this._camTheta, phi: this._camPhi };
      wrap.setPointerCapture?.(e.pointerId);
      wrap.classList.add('dragging');
    };

    const moveDrag = e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (e.buttons !== undefined && e.buttons === 0) { endDrag(e); return; }
      if (window._seViewMode === '2d') { endDrag(e); return; }
      if (e.cancelable) e.preventDefault();
      const W = wrap.offsetWidth  || 300;
      const H = wrap.offsetHeight || 180;
      // one full width drag = 360° horizontal; one full height drag = 180° vertical
      this._camTheta = drag.theta + (e.clientX - drag.startX) / W * Math.PI * 2;
      this._camPhi   = Math.max(-Math.PI / 2 + 0.05,
                       Math.min( Math.PI / 2 - 0.05,
                         drag.phi - (e.clientY - drag.startY) / H * Math.PI));
      this._updatePreview();
    };

    const endDrag = e => {
      if (drag && e?.pointerId != null && wrap.hasPointerCapture?.(e.pointerId)) {
        wrap.releasePointerCapture?.(e.pointerId);
      }
      drag = null;
      wrap.classList.remove('dragging');
    };

    // Expose so seSetView can cancel active drag when switching modes
    window._seResetDrag = endDrag;

    wrap.addEventListener('pointerdown', startDrag);
    wrap.addEventListener('pointermove', moveDrag);
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('lostpointercapture', endDrag);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') endDrag(e); });
    window.addEventListener('blur', endDrag);
  }

  _renderPresets(countFilter) {
    const family = this._selectedFamily || 'bars';
    const category = this._selectedCategory || 'הכל';
    const sideCount = this._selectedSideCount === undefined || this._selectedSideCount === 'הכל' ? countFilter : Number(this._selectedSideCount);
    const shapes = SHAPE_PRESETS.filter(s => {
      const sameFamily = (s.family || 'bars') === family;
      const n = Array.isArray(s.sides) ? s.sides.length : 0;
      const countOk = !sideCount || family !== 'bars' || n === sideCount;
      const categoryOk = family !== 'bars' || category === 'הכל' || s.category === category;
      return sameFamily && countOk && categoryOk;
    });
    const cont = document.getElementById('sePresets');
    cont.innerHTML = shapes.map(s => {
      return '<button class="se-preset-btn" data-id="'+s.id+'" title="'+s.name+'" aria-label="'+s.name+'">'
        + shapePresetIconSVG(s.icon || 'straight')
        + '<span class="se-preset-name">'+s.name+'</span>'
        + '</button>';
    }).join('');
    cont.querySelectorAll('.se-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = SHAPE_PRESETS.find(s => s.id === btn.dataset.id);
        if (preset) this._loadPreset(preset);
      });
    });
  }

  _renderSavedShapes(countFilter) {
    const saved  = loadSavedShapes();
    const cont   = document.getElementById('seSavedSection');
    if (!cont) return;
    const currentFamily = this._selectedFamily || 'bars';
    const sideCount = this._selectedSideCount === undefined || this._selectedSideCount === 'הכל' ? countFilter : Number(this._selectedSideCount);
    const list = saved.filter(s => {
      const sf = s.family || 'bars';
      if (sf !== currentFamily) return false;
      if (currentFamily === 'bars' && sideCount) return (s.sides || []).length === sideCount;
      return true;
    });
    if (list.length === 0) { cont.innerHTML = ''; return; }

    const cardsHtml = list.map(s => {
      const sf = s.family || 'bars';
      let svgStr;
      if (sf === 'spirals') {
        svgStr = ShapeEngineRouter.render(s, 100, 68);
      } else if (sf === 'mesh') {
        svgStr = MeshEngine.render(s, 100, 68);
      } else if (sf === 'piles') {
        svgStr = PileCageEngine.render(s, 100, 68);
      } else {
        svgStr = shape3DSVG(s.sides || [], s.angles || [], 100, 68, 12, { showAxes: false, showDims: false, dark: false });
      }
      return `<button class="se-preset-btn" data-saved-id="${s.id}" title="${s.name}" aria-label="${s.name}" style="position:relative;">
        <svg viewBox="0 0 100 68" aria-hidden="true">${svgStr}</svg>
        <span class="se-preset-name">${s.name}</span>
        <button class="se-del-saved-btn" data-del-id="${s.id}" title="מחק צורה">✕</button>
      </button>`;
    }).join('');

    cont.innerHTML = `
      <div style="padding:10px 16px 4px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #dde4ed;">
        <span style="font-size:11px;font-weight:800;color:#3a7bd5;text-transform:uppercase;letter-spacing:0.5px;">⭐ צורות שמורות שלי</span>
        <span style="font-size:10px;color:#aab8c8;margin-right:auto;">${list.length} צורות</span>
      </div>
      <div class="se-saved-grid">${cardsHtml}</div>
      <div style="height:1px;background:#dde4ed;margin:0 16px 8px;"></div>`;

    cont.querySelectorAll('[data-saved-id]').forEach(btn => {
      btn.addEventListener('click', e => {
        if (e.target.closest('.se-del-saved-btn')) return;
        const shape = loadSavedShapes().find(s => s.id === btn.dataset.savedId);
        if (shape) this._loadSavedShape(shape);
      });
    });
    cont.querySelectorAll('.se-del-saved-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm('למחוק את הצורה הזו?')) return;
        deleteSavedShape(btn.dataset.delId);
        this._renderSavedShapes(countFilter);
      });
    });
  }

  _loadSavedShape(saved) {
    const family = saved.family || 'bars';
    if (family === 'spirals') {
      this.current = { ...saved, family: 'spirals', presetId: saved.id, presetName: saved.name, presetEmoji: '⭐' };
    } else if (family === 'mesh') {
      this.current = { ...saved, family: 'mesh', presetId: saved.id, presetName: saved.name, presetEmoji: '⭐' };
    } else if (family === 'piles') {
      this.current = { ...saved, family: 'piles', presetId: saved.id, presetName: saved.name, presetEmoji: '⭐' };
      this.current.spiralZones = (saved.spiralZones || []).map(zone => ({ ...zone }));
      this._pileCageTemplateMode = saved.roundPileCage && matchesRoundPileCageStandardZones(saved)
        ? ROUND_PILE_CAGE_STANDARD_TEMPLATE
        : 'custom';
    } else {
      const n = (saved.sides || []).length;
      this.current = {
        presetId:    saved.id,
        presetName:  saved.name,
        presetEmoji: '⭐',
        family:      'bars',
        sides:       [...(saved.sides || [])],
        angles:      [...(saved.angles || [])],
        azAngles:    saved.azAngles ? [...saved.azAngles] : Array(n).fill(0),
        elAngles:    saved.elAngles ? [...saved.elAngles] : Array(n).fill(0),
      };
    }
    this._goToEdit();
  }

  _showSaveBar() {
    document.getElementById('seFootNormal').style.display = 'none';
    const bar = document.getElementById('seFootSave');
    bar.style.display = 'flex';
    const inp = document.getElementById('seSaveNameInput');
    if (inp) { inp.value = this.current?.presetName || ''; setTimeout(() => { inp.focus(); inp.select(); }, 60); }
  }

  _hideSaveBar() {
    document.getElementById('seFootSave').style.display   = 'none';
    document.getElementById('seFootNormal').style.display = 'flex';
  }

  _doSave() {
    if (!this.current) return;
    const inp  = document.getElementById('seSaveNameInput');
    const name = (inp?.value || '').trim() || this.current.presetName || 'צורה מותאמת';
    persistSavedShape(this.current, name);
    this._hideSaveBar();
    this._showToast('✅ "' + name + '" נשמרה בהצלחה');
    this._renderSidebarSavedShapes(normalizeShapeFamily(this.current || {}));
  }

  _showToast(msg) {
    let t = document.getElementById('seToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'seToast';
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);'
        + 'background:#1a2332;color:#fff;padding:11px 22px;border-radius:10px;'
        + 'font-family:Heebo,sans-serif;font-size:14px;font-weight:700;z-index:600;'
        + 'opacity:0;transition:opacity 0.25s;pointer-events:none;white-space:nowrap;'
        + 'box-shadow:0 4px 20px rgba(0,0,0,0.35);';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2800);
  }

  _loadPreset(preset) {
    const isBlankNewEntry = this._blankNewEntry === true;
    const sides = (Array.isArray(preset.sides) ? [...preset.sides] : [])
      .map(value => isBlankNewEntry ? 0 : value);
    const angles = Array.isArray(preset.angles) ? [...preset.angles] : [];
    const n = sides.length;
    const isReal3D = preset.is3d === 1 || preset.is3d === true;
    const presetAzAngles = Array.isArray(preset.azAngles) && preset.azAngles.length === n
      ? [...preset.azAngles]
      : [0, ...angles.map(a => 180 - (a ?? 180))].slice(0, n);
    const presetElAngles = Array.isArray(preset.elAngles) && preset.elAngles.length === n
      ? [...preset.elAngles]
      : Array(n).fill(0);
    this.current = {
      ...preset,
      presetId:    preset.id,
      presetName:  preset.name,
      presetEmoji: preset.emoji,
      sides,
      angles,
      diameter:   isBlankNewEntry ? 0 : (Number(preset.diameter ?? this.current?.diameter ?? this._pendingDiameter ?? 0) || 0),
      quantity:    isBlankNewEntry ? 0 : Math.max(1, Number(this.current?.quantity || this._pendingQuantity || preset.quantity || preset.qty || 1) || 1),
      is3d:        isReal3D ? 1 : 0,
      azAngles:    presetAzAngles,
      elAngles:    presetElAngles,
    };
    if (this.current.family === 'piles' && this.current.roundPileCage && preset.bendOrientationDeg == null) {
      this.current.bendOrientationDeg = loadPileBendOrientationDefault();
    }
    if (this.current.family === 'piles') {
      this.current.spiralZones = (preset.spiralZones || []).map(zone => ({ ...zone }));
      this._pileCageTemplateMode = this.current.roundPileCage && matchesRoundPileCageStandardZones(this.current)
        ? ROUND_PILE_CAGE_STANDARD_TEMPLATE
        : 'custom';
    }
    // pad azAngles if needed
    while (this.current.azAngles.length < n) this.current.azAngles.push(0);
    document.querySelectorAll('.se-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.id === preset.id));
    this._previewRotation = shapePreviewRotation(preset);
    seSyncRotateButton();
    if (isReal3D) window.seSetView?.('3d');
    this._goToEdit();
  }

  _renderTable() {
    if (!this.current) return;
    if (this.current.family === 'lifts')   return this._renderLiftEditor();
    if (this.current.family === 'mesh')    return this._renderMeshEditor();
    if (this.current.family === 'piles')   return this._renderPileCageEditor();
    if (isStandaloneRingShape(this.current)) return this._renderRingEditor();
    if (this.current.family === 'spirals') return this._renderSpiralEditor();
    return this._renderBarEditor();
  }

  _inferFieldShellMeta({ focusKey = '', number = '', code = '', example = '', input = '' }) {
    const inputText = String(input || '');
    const attr = (name) => {
      const match = inputText.match(new RegExp(name + '="([^"]+)"'));
      return match ? match[1] : '';
    };
    const rowNumber = (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return '';
      return String.fromCharCode(9312 + Math.min(19, Math.max(0, n)));
    };
    const byField = {
      length: { focusKey: 'mesh-length', number: String.fromCharCode(9312), code: 'L' },
      width: { focusKey: 'mesh-width', number: String.fromCharCode(9313), code: 'W' },
      longitudinalDiameter: { focusKey: 'mesh-longitudinal-diameter', number: String.fromCharCode(9314), code: 'D' },
      longitudinalSpacing: { focusKey: 'mesh-longitudinal-spacing', number: String.fromCharCode(9315), code: '@' },
      transverseDiameter: { focusKey: 'mesh-transverse-diameter', number: String.fromCharCode(9316), code: 'D' },
      transverseSpacing: { focusKey: 'mesh-transverse-spacing', number: String.fromCharCode(9317), code: '@' },
      edgeLeft: { focusKey: 'mesh-edge', number: String.fromCharCode(9318), code: 'E' },
      edgeRight: { focusKey: 'mesh-edge', number: String.fromCharCode(9319), code: 'E' },
      edgeTop: { focusKey: 'mesh-edge', number: String.fromCharCode(9320), code: 'E' },
      edgeBottom: { focusKey: 'mesh-edge', number: String.fromCharCode(9321), code: 'E' },
      pileDiameter: { focusKey: 'pile-diameter', number: String.fromCharCode(9312), code: 'D' },
      pileLength: { focusKey: 'pile-length', number: String.fromCharCode(9313), code: 'L' },
      longitudinalBars: { focusKey: 'pile-longitudinal-bars', number: String.fromCharCode(9314), code: 'N' },
      longitudinalDiameter: { focusKey: 'pile-longitudinal-diameter', number: String.fromCharCode(9315), code: 'D' },
      spiralDiameter: { focusKey: 'pile-spiral-diameter', number: String.fromCharCode(9316), code: 'D' },
      spiralType: { focusKey: 'pile-spiral-pitch', number: String.fromCharCode(9317), code: 'S' },
      hoopsEnabled: { focusKey: 'pile-hoops', number: String.fromCharCode(9318), code: 'H' },
      hoopDiameter: { focusKey: 'pile-hoop-diameter', number: String.fromCharCode(9319), code: 'Dh' },
      hoopSpacing: { focusKey: 'pile-hoop-spacing', number: String.fromCharCode(9320), code: '@' },
      hoopStart: { focusKey: 'pile-hoops', number: String.fromCharCode(9321), code: 'Hs' },
      hoopEnd: { focusKey: 'pile-hoops', number: String.fromCharCode(9322), code: 'He' },
      barPattern: { focusKey: 'pile-l-bars', number: String.fromCharCode(9323), code: 'B' },
      lHookLength: { focusKey: 'pile-l-hook', number: String.fromCharCode(9324), code: 'L' },
    };
    let meta = { focusKey, number, code, example };
    const meshField = attr('data-mesh-field');
    const pileField = attr('data-pile-field');
    const zoneField = attr('data-zone-field');
    const side = attr('data-side');
    const angle = attr('data-angle');
    const az = attr('data-az');
    const el = attr('data-el');
    if (meshField && byField[meshField]) meta = { ...meta, ...byField[meshField] };
    if (pileField && byField[pileField]) meta = { ...meta, ...byField[pileField] };
    if (zoneField === 'name') meta = { ...meta, focusKey: 'pile-zone', number: String.fromCharCode(9317), code: 'Z' };
    if (zoneField === 'length') meta = { ...meta, focusKey: 'pile-zone', number: String.fromCharCode(9318), code: 'Lz' };
    if (zoneField === 'pitch') meta = { ...meta, focusKey: 'pile-spiral-pitch', number: String.fromCharCode(9319), code: 'P' };
    if (zoneField === 'noWrap') meta = { ...meta, focusKey: 'pile-no-wrap', number: String.fromCharCode(9320), code: 'NW' };
    if (side !== '') meta = { ...meta, focusKey: `bar-side-${side}`, number: rowNumber(side), code: 'L' };
    if (angle !== '') meta = { ...meta, focusKey: `bar-angle-${angle}`, number: rowNumber(angle), code: 'A' };
    if (az !== '') meta = { ...meta, focusKey: `bar-angle-${az}`, number: rowNumber(az), code: 'A' };
    if (el !== '') meta = { ...meta, focusKey: `bar-z-${el}`, number: rowNumber(el), code: 'Z' };
    return meta;
  }

  _fieldShell({ icon, label, unit, example, input, focusKey = '', number = '', code = '' }) {
    ({ focusKey, number, code, example } = this._inferFieldShellMeta({ focusKey, number, code, example, input }));
    const focusAttrs = focusKey
      ? ` data-se-param="${focusKey}" onmouseenter="window._seEditor?._setFieldFocus('${focusKey}')" onmouseleave="window._seEditor?._clearFieldFocus('${focusKey}')" onfocusin="window._seEditor?._setFieldFocus('${focusKey}')" onfocusout="window._seEditor?._clearFieldFocus('${focusKey}')"`
      : '';
    return `<div class="se-field-shell"${focusAttrs}><span class="se-param-label">${label}</span>${input}<span class="se-param-unit">${unit}</span><span class="se-param-example">${example}</span></div>`;
  }

  _setFieldFocus(key) {
    this._activeFieldFocus = key;
    document.querySelectorAll('#seModal .se-field-shell').forEach(el => el.classList.toggle('se-param-active', el.dataset.seParam === key));
    this._updatePreview();
  }

  _clearFieldFocus(key) {
    if (this._activeFieldFocus !== key) return;
    this._activeFieldFocus = '';
    document.querySelectorAll('#seModal .se-field-shell').forEach(el => el.classList.remove('se-param-active'));
    this._updatePreview();
  }

  _jumpToFamily(family) {
    this._selectedFamily = family;
    this._selectedCategory = '';
    this._selectedSideCount = null;
    this._selectedCount = null;
    this._startDefaultEdit(this._selectedFamily);
  }

  _syncEditFamilyCards() {
    const family = normalizeShapeFamily(this.current || {});
    const editorKind = isStandaloneRingShape(this.current) ? 'ring' : (isBenchBarShape(this.current) ? 'bench' : (isRoundedEndBarShape(this.current) ? 'rounded' : family));
    document.querySelectorAll('[data-edit-family]').forEach(btn => btn.classList.toggle('active', btn.dataset.editFamily === editorKind));
    this._renderSidebarSavedShapes(family);
  }

  _renderSidebarSavedShapes(family) {
    const cont = document.getElementById('seSidebarSaved');
    if (!cont) return;
    const list = loadSavedShapes().filter(s => (s.family || 'bars') === family);
    if (!list.length) { cont.innerHTML = ''; return; }
    const cards = list.map(s => {
      const sf = s.family || 'bars';
      let inner;
      if (sf === 'spirals') inner = ShapeEngineRouter.render(s, 100, 68);
      else if (sf === 'mesh') inner = MeshEngine.render(s, 100, 68);
      else if (sf === 'piles') inner = PileCageEngine.render(s, 100, 68);
      else inner = shape3DSVG(s.sides || [], s.angles || [], 100, 68, 12, { showAxes: false, showDims: false });
      return `<button class="se-preset-btn se-sidebar-saved-btn" data-saved-id="${s.id}" title="${s.name}" aria-label="${s.name}" style="position:relative;">
        <svg viewBox="0 0 100 68" aria-hidden="true">${inner}</svg>
        <button class="se-del-saved-btn" data-del-id="${s.id}" title="מחק">✕</button>
      </button>`;
    }).join('');
    cont.innerHTML = `<div style="font-size:10px;font-weight:800;color:#8a96a6;margin-bottom:6px;letter-spacing:0.4px;">⭐ שמורות</div>
      <div style="display:flex;flex-direction:column;gap:8px;">${cards}</div>`;
    cont.querySelectorAll('.se-sidebar-saved-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        if (e.target.closest('.se-del-saved-btn')) return;
        const shape = loadSavedShapes().find(s => s.id === btn.dataset.savedId);
        if (shape) this._loadSavedShape(shape);
      });
    });
    cont.querySelectorAll('.se-del-saved-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm('למחוק?')) return;
        deleteSavedShape(btn.dataset.delId);
        this._renderSidebarSavedShapes(family);
      });
    });
  }

  _focusFamilyField(key) {
    this._setFieldFocus(key);
  }

  _focusKeyMatches(tokens, key) {
    if (!key) return false;
    const parts = String(tokens || '').split(/\s+/).filter(Boolean);
    return parts.includes(key) || parts.some(part => key.startsWith(part + '-') || part.startsWith(key + '-'));
  }

  _applyFamilyFocus(svg) {
    const key = this._activeFieldFocus || this._activeFamilyField;
    if (!svg) return;
    svg.classList.toggle('se-focus-mode', !!key);
    svg.querySelectorAll('.se-focus-hit,.se-highlight-family').forEach(el => el.classList.remove('se-focus-hit', 'se-highlight-family'));
    if (!key) return;
    svg.querySelectorAll('[data-se-focus]').forEach(el => {
      if (this._focusKeyMatches(el.getAttribute('data-se-focus'), key)) el.classList.add('se-focus-hit');
    });
  }

  _updateSummaryValues() {
    if (!this.current) return;
    const contract = buildShapeDataContractV2(this.current);
    const totalMm = Number(contract.calculated?.totalLengthMm || 0);
    const weightKg = Number(contract.calculated?.weightKg || 0);
    // Quantity may legitimately be 0 (not entered yet) — confirm is blocked
    // until it is filled, so don't force a minimum here.
    const qty = Math.max(0, Number(this.current.quantity ?? this.current.qty ?? 0) || 0);
    this.current.quantity = qty;
    const bends = Array.isArray(this.current.angles) ? this.current.angles.length : (Array.isArray(this.current.spiralZones) ? this.current.spiralZones.length : 0);
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('sePerimeter', (totalMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }));
    set('seBarLength', (totalMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 2 }));
    set('seTotalWeight', weightKg.toFixed(2));
    const qtyInput = document.getElementById('seQuantityInput');
    if (qtyInput && document.activeElement !== qtyInput) qtyInput.value = qty > 0 ? String(qty) : '';
    const diaSelect = document.getElementById('seDiameterSelect');
    if (diaSelect && document.activeElement !== diaSelect) {
      const finish = String(this.current.steelFinish || this.current.steel_finish || '').toLowerCase();
      diaSelect.value = finish === 'smooth' && [8, 10].includes(Number(this.current.diameter))
        ? `${this.current.diameter}|smooth`
        : String(this.current.diameter || 0);
    }
    const radiusInput = document.getElementById('seRadiusInput');
    if (radiusInput && document.activeElement !== radiusInput) {
      const radiusMm = Number(this.current.radiusMm);
      radiusInput.value = Number.isFinite(radiusMm) && radiusMm > 0 ? String(radiusMm / 10) : '';
    }
    const straightLengthInput = document.getElementById('seStraightLengthInput');
    if (straightLengthInput && document.activeElement !== straightLengthInput) {
      const value = Number(this.current.sides?.[0] || 0);
      straightLengthInput.value = String(value);
    }
    const straightDiameterInput = document.getElementById('seStraightDiameterInput');
    if (straightDiameterInput && document.activeElement !== straightDiameterInput) {
      const value = Number(this.current.diameter || 0);
      straightDiameterInput.value = value > 0 ? String(value) : '';
    }
    const straightQuantityInput = document.getElementById('seStraightQuantityInput');
    if (straightQuantityInput && document.activeElement !== straightQuantityInput) straightQuantityInput.value = String(qty);
    set('seBends', bends);
    set('sePanelTotalMm', (totalMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }));
    set('sePanelTotalM', (totalMm / 10).toLocaleString('he-IL', { maximumFractionDigits: 2 }));
    set('sePanelBends', bends);
  }

  _setQuantity(value) {
    if (!this.current) return;
    const qty = Math.max(0, Math.round(Number(value) || 0));
    this.current.quantity = qty;
    const el = document.getElementById('seQuantityInput');
    if (el) el.classList.toggle('se-invalid', !(qty >= 1));
    this._updateSummaryValues();
  }

  _setDiameter(value) {
    if (!this.current) return;
    const [diameter, finish] = String(value ?? '').split('|');
    this.current.diameter = Number(diameter) || 0;
    this.current.steelFinish = finish === 'smooth' ? 'smooth' : 'ribbed';
    const el = document.getElementById('seDiameterSelect');
    if (el) el.classList.toggle('se-invalid', !(this.current.diameter >= 5.5));
    this._updatePreview();
  }

  _setBendRadius(value) {
    if (!this.current) return;
    const raw = String(value ?? '').trim();
    const cm = Number(raw);
    this.current.roundedBends = true;
    this.current.shapeType = 'rounded_end_bar';
    this.current.radiusMm = raw && Number.isFinite(cm) && cm > 0 ? Math.round(cm * 10) : null;
    this._updatePreview({ debounceMs: 120 });
  }

  _setStraightLength(value) {
    if (!this.current) return;
    // Input is centimeters; sides are stored in millimeters.
    const lengthCm = Number(value);
    this.current.sides = [Number.isFinite(lengthCm) && lengthCm > 0 ? Math.round(lengthCm * 10) : 0];
    this.current.angles = [];
    this.current.is3d = 0;
    this.current.azAngles = [0];
    this.current.elAngles = [0];
    this.current.family = 'bars';
    this.current.shapeType = 'straight_bar';
    this._updatePreview();
  }

  _setStraightDiameter(value) {
    this._setDiameter(value);
  }

  _setStraightQuantity(value) {
    this._setQuantity(value);
  }

  _setFamilyEditorChrome(kind) {
    const table = document.querySelector('#seModal .se-table');
    const thead = document.getElementById('seTableHead');
    const addRow = document.querySelector('#seModal .se-add-row');
    const modeNote = document.querySelector('#seModal .se-mode-note');
    const summary = document.querySelector('#seModal .se-panel-summary');
    const title = document.querySelector('#seModal .se-data-panel-head');
    const isBars = kind === 'bars';
    const showsOrderQuantity = isBars || kind === 'ring' || kind === 'lifts';
    document.getElementById('seModal')?.classList.toggle('se-ring-editor', kind === 'ring');
    document.getElementById('seModal')?.classList.toggle('se-pile-editor', kind === 'piles');
    if (table) table.classList.toggle('se-family-editor-table', !isBars);
    if (thead) thead.style.display = isBars ? '' : 'none';
    if (addRow) addRow.style.display = isBars ? '' : 'none';
    if (modeNote) modeNote.style.display = isBars ? '' : 'none';
    if (summary) summary.style.display = isBars ? '' : 'none';
    if (title) {
      const titleText = kind === 'lifts' ? 'חבילת ליפטים' : kind === 'mesh' ? 'עריכת רשת' : kind === 'piles' ? 'עריכת כלונס' : kind === 'spirals' ? 'עריכת ספיראלה' : kind === 'ring' ? 'עריכת טבעת' : 'מידות צלעות וזוויות';
      const titleSpan = title.querySelector('span:first-child');
      if (titleSpan) titleSpan.textContent = titleText; else title.textContent = titleText;
    }
    // Diameter and quantity live in the footer for bar shapes so every bar —
    // straight or bent — is edited the same way.
    const diaItem = document.getElementById('seDiameterItem');
    if (diaItem) diaItem.style.display = isBars ? '' : 'none';
    const radiusItem = document.getElementById('seRadiusItem');
    if (radiusItem) radiusItem.style.display = isBars && isRoundedEndBarShape(this.current) ? '' : 'none';
    const qtyItem = document.querySelector('#seModal .se-quantity-item');
    if (qtyItem) qtyItem.style.display = showsOrderQuantity ? '' : 'none';
  }

  _renderLiftEditor() {
    this._setFamilyEditorChrome('lifts');
    const lift = this.current;
    if (lift.diameter == null) lift.diameter = 12;
    if (lift.barLength == null) lift.barLength = 1200;
    if (lift.weighedKg == null) lift.weighedKg = 0;
    const body = document.getElementById('seTableBody');
    if (!body) return;
    const meta = {
      diameter:  ['Ø','קוטר ברזל','מ״מ','לדוגמה 12'],
      barLength: ['📏','אורך מוט','ס״מ','לדוגמה 120'],
      weighedKg: ['⚖','משקל כולל אחרי שקילה','ק״ג','לדוגמה 194'],
    };
    const field = (key, min = 0, step = 0.1) => {
      const m = meta[key] || ['•', key, '', ''];
      const value = key === 'barLength' ? (Number(lift[key] ?? 0) / 10) : (lift[key] ?? 0);
      return '<td colspan="2">' + this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], input:`<input class="se-input" type="number" min="${min}" step="${step}" value="${value}" data-lift-field="${key}" oninput="window._seEditor._setLiftField(\'${key}\', this.value)">` }) + '</td>';
    };
    body.innerHTML = `
      <tr class="se-family-row">${field('diameter', 1)}${field('barLength', 1)}</tr>
      <tr class="se-family-row">${field('weighedKg', 0, 0.1)}<td colspan="2"><div class="se-lift-note">שוקלים את כל החבילות יחד — המשקל הזה הוא הסה״כ, והכמות לא מוכפלת בו.</div></td></tr>`;
  }

  _setLiftField(key, val) {
    if (!this.current) return;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return;
    this.current[key] = key === 'barLength' ? n * 10 : n;
    this._render();
    this._updateSummaryValues();
  }

  _renderMeshEditor() {
    this._setFamilyEditorChrome('mesh');
    const mesh = this.current;
    const body = document.getElementById('seTableBody');
    if (!body) return;
    const meta = {
      length: ['📏','אורך רשת','ס״מ','לדוגמה 60'], width: ['↕','רוחב רשת','ס״מ','לדוגמה 25'],
      longitudinalDiameter: ['Ø','קוטר לאורך','מ״מ','לדוגמה 8'], longitudinalSpacing: ['↔','מרווח לאורך','ס״מ','לדוגמה 20'],
      transverseDiameter: ['Ø','קוטר לרוחב','מ״מ','לדוגמה 8'], transverseSpacing: ['↕','מרווח לרוחב','ס״מ','לדוגמה 20'],
      edgeLeft: ['←','שול שמאל','ס״מ','לדוגמה 0'], edgeRight: ['→','שול ימין','ס״מ','לדוגמה 0'],
      edgeTop: ['↑','שול עליון','ס״מ','לדוגמה 0'], edgeBottom: ['↓','שול תחתון','ס״מ','לדוגמה 0'],
    };
    const field = (key, min = 0) => {
      const m = meta[key] || ['•', key, 'ס״מ', 'לדוגמה 10'];
      const isSteelDiameter = key === 'longitudinalDiameter' || key === 'transverseDiameter';
      const value = isSteelDiameter ? (mesh[key] ?? 0) : (Number(mesh[key] ?? 0) / 10);
      return '<td colspan="2">' + this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], focusKey:m[4], number:m[5], code:m[6], input:`<input class="se-input" type="number" min="${min}" step="0.1" value="${value}" data-mesh-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" oninput="window._seEditor._setMeshField('${key}', this.value)">` }) + '</td>';
    };
    body.innerHTML = `
      <tr class="se-family-row">${field('length', 1)}${field('width', 1)}</tr>
      <tr class="se-family-row">${field('longitudinalDiameter', 1)}${field('longitudinalSpacing', 1)}</tr>
      <tr class="se-family-row">${field('transverseDiameter', 1)}${field('transverseSpacing', 1)}</tr>
      <tr class="se-family-row">${field('edgeLeft', 0)}${field('edgeRight', 0)}</tr>
      <tr class="se-family-row">${field('edgeTop', 0)}${field('edgeBottom', 0)}</tr>`;
  }

  _renderRingEditor() {
    this._setFamilyEditorChrome('ring');
    const ring = this.current;
    const body = document.getElementById('seTableBody');
    if (!body) return;

    const barDiameter = Math.max(1, Number(ring.barDiameter || 18));
    const ringDiameterMm = Math.max(1, Number(ring.ringDiameter || ring.spiralDiameter || 420));
    const overlapMm = Math.max(0, Number(ring.overlap || ring.overlapMm || 0));
    const circumferenceMm = Math.PI * ringDiameterMm;
    const totalLengthMm = circumferenceMm + overlapMm;
    const field = ({ key, id, label, unit, example, min = 0, value }) =>
      `<td colspan="2">${this._fieldShell({ icon: '', label, unit, example, focusKey: `ring-${key}`,
        input: `<input id="${id}" class="se-input" type="number" min="${min}" step="0.1" value="${value}"
          onfocus="window._seEditor._focusFamilyField('ring-${key}')"
          oninput="window._seEditor._setRingField('${key}', this.value)">` })}</td>`;
    const computedRow = (label, value, unit) =>
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;
        background:#f0fdf4;border-radius:6px;font-size:12px;margin:2px 0">
        <span style="color:#526070;font-weight:600">${label}</span>
        <span style="font-weight:800;color:#15803d">${value} <span style="font-weight:400;color:#888">${unit}</span></span>
      </div>`;

    body.innerHTML = `
      <tr class="se-family-row"><td colspan="4" style="padding:4px 0">
        <div style="font-size:11px;font-weight:800;color:#526070;padding:0 4px;letter-spacing:0.5px">פרטי הטבעת</div>
      </td></tr>
      <tr class="se-family-row">
        ${field({ key:'barDiameter', id:'seRingBarDiameter', label:'Ø קוטר ברזל', unit:'מ״מ', example:'לדוגמה 18', min:1, value:barDiameter })}
        ${field({ key:'ringDiameter', id:'seRingDiameter', label:'Ø קוטר טבעת', unit:'ס״מ', example:'לדוגמה 42', min:0.1, value:ringDiameterMm / 10 })}
      </tr>
      <tr class="se-family-row">
        ${field({ key:'overlap', id:'seRingOverlap', label:'חפיפה', unit:'ס״מ', example:'לדוגמה 20', min:0, value:overlapMm / 10 })}
        <td colspan="2"></td>
      </tr>
      <tr class="se-family-row"><td colspan="4" style="padding:4px 0">
        <div style="font-size:11px;font-weight:800;color:#526070;padding:0 4px;letter-spacing:0.5px">מחושב</div>
      </td></tr>
      <tr class="se-family-row" data-ring-computed><td colspan="4">
        ${computedRow('היקף', Math.round(circumferenceMm / 10), 'ס״מ')}
        ${computedRow('אורך חיתוך כולל חפיפה', Math.round(totalLengthMm / 10), 'ס״מ')}
        ${computedRow('משקל ליחידה Ø' + barDiameter, ((totalLengthMm / 1000) * sharedKgPerMeter(barDiameter)).toFixed(2), 'ק״ג')}
      </td></tr>`;
  }

  _setRingField(key, value) {
    if (!this.current || !isStandaloneRingShape(this.current)) return;
    const numeric = Number(value);
    if (key === 'barDiameter') this.current.barDiameter = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
    if (key === 'ringDiameter') {
      this.current.ringDiameter = Number.isFinite(numeric) ? Math.max(0, numeric * 10) : 0;
      this.current.spiralDiameter = this.current.ringDiameter;
    }
    if (key === 'overlap') this.current.overlap = Number.isFinite(numeric) ? Math.max(0, numeric * 10) : 0;
    this.current.turns = 1;
    this.current.family = 'spirals';
    this.current.shapeType = 'ring';
    this.current.specialty = 'ring';
    this._updatePreview();
    this._refreshRingComputed();
  }

  _refreshRingComputed() {
    const ring = this.current;
    if (!ring) return;
    const barDiameter = Math.max(0, Number(ring.barDiameter || 0));
    const ringDiameterMm = Math.max(0, Number(ring.ringDiameter || ring.spiralDiameter || 0));
    const overlapMm = Math.max(0, Number(ring.overlap || ring.overlapMm || 0));
    const circumferenceMm = Math.PI * ringDiameterMm;
    const totalLengthMm = circumferenceMm + overlapMm;
    const el = document.querySelector('#seTableBody [data-ring-computed]');
    if (!el) return;
    const computedRow = (label, value, unit) =>
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;
        background:#f0fdf4;border-radius:6px;font-size:12px;margin:2px 0">
        <span style="color:#526070;font-weight:600">${label}</span>
        <span style="font-weight:800;color:#15803d">${value} <span style="font-weight:400;color:#888">${unit}</span></span>
      </div>`;
    el.innerHTML = `<td colspan="4">
      ${computedRow('היקף', Math.round(circumferenceMm / 10), 'ס״מ')}
      ${computedRow('אורך חיתוך כולל חפיפה', Math.round(totalLengthMm / 10), 'ס״מ')}
      ${computedRow('משקל ליחידה Ø' + barDiameter, ((totalLengthMm / 1000) * sharedKgPerMeter(barDiameter)).toFixed(2), 'ק״ג')}
    </td>`;
  }

  _renderSpiralEditor() {
    this._setFamilyEditorChrome('spirals');
    const sp = this.current;
    const body = document.getElementById('seTableBody');
    if (!body) return;

    const barDia    = Math.max(1, Number(sp.barDiameter    || 8));
    const spiralDia = Math.max(1, Number(sp.spiralDiameter || 400));
    const turns     = Math.max(1, Number(sp.turns          || 20));
    const totalMm   = Math.round(turns * Math.PI * spiralDia);

    const field = (key, label, unit, example, min = 1) =>
      `<td colspan="2">${this._fieldShell({ icon: '', label, unit, example,
        input: `<input class="se-input" type="number" min="${min}" step="0.1" value="${key === 'spiralDiameter' ? Number(sp[key] ?? 0) / 10 : (sp[key] ?? 0)}"
          onfocus="window._seEditor._focusFamilyField('spiral-${key}')"
          oninput="window._seEditor._setSpiralField('${key}', this.value)">` })}</td>`;

    const cr = (label, v, unit) =>
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;
        background:#f0fdf4;border-radius:6px;font-size:12px;margin:2px 0">
        <span style="color:#526070;font-weight:600">${label}</span>
        <span style="font-weight:800;color:#15803d">${v} <span style="font-weight:400;color:#888">${unit}</span></span>
      </div>`;

    body.innerHTML = `
      <tr class="se-family-row"><td colspan="4" style="padding:4px 0">
        <div style="font-size:11px;font-weight:800;color:#526070;padding:0 4px;letter-spacing:0.5px">פרמטרים</div>
      </td></tr>
      <tr class="se-family-row">
        ${field('barDiameter',    'Ø קוטר ברזל',     'מ״מ', '8',   1)}
        ${field('spiralDiameter', 'Ø קוטר ספיראלה',  'ס״מ', '40', 0.1)}
      </tr>
      <tr class="se-family-row">
        ${field('turns', 'N', '', '20', 1)}
        <td colspan="2"></td>
      </tr>
      <tr class="se-family-row"><td colspan="4" style="padding:4px 0">
        <div style="font-size:11px;font-weight:800;color:#526070;padding:0 4px;letter-spacing:0.5px">מחושב</div>
      </td></tr>
      <tr class="se-family-row" data-spiral-computed>
        <td colspan="4">
          ${cr('היקף חוג', (Math.PI * spiralDia / 10).toFixed(1), 'ס״מ')}
          ${cr('אורך כולל', (totalMm / 10).toFixed(1), 'ס״מ')}
          ${cr('משקל Ø' + barDia, ((totalMm / 1000) * sharedKgPerMeter(barDia)).toFixed(2), 'ק״ג')}
        </td>
      </tr>`;
  }

  _setSpiralField(key, val) {
    if (!this.current || this.current.family !== 'spirals') return;
    this.current[key] = key === 'spiralDiameter'
      ? Math.max(1, (Number(val) || 0.1) * 10)
      : Math.max(1, Number(val) || 1);
    this._updatePreview();
    this._refreshSpiralComputed();
  }

  _refreshSpiralComputed() {
    const sp = this.current;
    if (!sp) return;
    const barDia    = Math.max(1, Number(sp.barDiameter    || 8));
    const spiralDia = Math.max(1, Number(sp.spiralDiameter || 400));
    const turns     = Math.max(1, Number(sp.turns          || 20));
    const totalMm   = Math.round(turns * Math.PI * spiralDia);
    const body = document.getElementById('seTableBody');
    if (!body) return;
    const el = body.querySelector('[data-spiral-computed]');
    if (!el) return;
    const cr = (label, v, unit) =>
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;
        background:#f0fdf4;border-radius:6px;font-size:12px;margin:2px 0">
        <span style="color:#526070;font-weight:600">${label}</span>
        <span style="font-weight:800;color:#15803d">${v} <span style="font-weight:400;color:#888">${unit}</span></span>
      </div>`;
    el.innerHTML = `<td colspan="4">
      ${cr('היקף חוג', (Math.PI * spiralDia / 10).toFixed(1), 'ס״מ')}
      ${cr('אורך כולל', (totalMm / 10).toFixed(1), 'ס״מ')}
      ${cr('משקל Ø' + barDia, ((totalMm / 1000) * sharedKgPerMeter(barDia)).toFixed(2), 'ק״ג')}
    </td>`;
  }

  _renderPileCageEditor() {
    this._setFamilyEditorChrome('piles');
    const pile = this.current;
    const body = document.getElementById('seTableBody');
    if (!body) return;
    if (!Array.isArray(pile.spiralZones)) pile.spiralZones = [];
    if (!pile.spiralZones.length) pile.spiralZones = [{ name: 'Zone A', length: 70, pitch: 10 }, { name: 'Zone B', length: 200, pitch: 20 }, { name: 'Zone C', length: 1350, pitch: 20 }];
    if (pile.spiralType == null) pile.spiralType = 'zoned';
    if (pile.hoopsEnabled == null) pile.hoopsEnabled = true;
    if (pile.hoopDiameter == null) pile.hoopDiameter = 14;
    if (pile.hoopSpacing == null) pile.hoopSpacing = 200;
    if (pile.hoopStart == null) pile.hoopStart = 0;
    if (pile.hoopEnd == null) pile.hoopEnd = pile.pileLength || 2200;
    if (!pile.hoopStartSide) pile.hoopStartSide = 'start';
    if (!pile.hoopShape) pile.hoopShape = 'round';
    if (!pile.barPattern) pile.barPattern = 'straight';
    if (!pile.barSpacingDisplayMode) pile.barSpacingDisplayMode = 'center';
    if (pile.lHookLength == null) pile.lHookLength = 25;
    if (pile.bendAngle == null) pile.bendAngle = 90;
    if (pile.roundPileCage && pile.bendOrientationDeg == null) pile.bendOrientationDeg = loadPileBendOrientationDefault();
    if (!Array.isArray(pile.longitudinalBarOverrides)) pile.longitudinalBarOverrides = [];
    const meta = {
      pileDiameter: ['Ø','קוטר כלונס (ס״מ)','ס״מ','70'], pileLength: ['L','אורך כלונס (ס״מ)','ס״מ','2200'],
      longitudinalBars: ['N','מספר מוטות אורך (יח׳)','יח׳','26'], longitudinalDiameter: ['Ø','קוטר ברזל מוטות (מ״מ)','מ״מ','22'],
      spiralDiameter: ['Ø','קוטר ברזל ספירלה (מ״מ)','מ״מ','8'], spiralType: ['S','סוג ספירלה','','zoned'],
      hoopsEnabled: ['H','טבעות פנימיות','','פעיל'], hoopDiameter: ['Ø','קוטר ברזל טבעת (מ״מ)','מ״מ','14'],
      hoopSpacing: ['@','מרווח טבעות (ס״מ)','ס״מ','200'], hoopStart: ['↦','תחילת טבעות (ס״מ)','ס״מ','0'], hoopEnd: ['↤','סוף טבעות (ס״מ)','ס״מ','2200'],
      hoopStartSide: ['⇄','צד התחלה','','מהתחלה'], hoopShape: ['⬡','צורת טבעת','','עגול'], barPattern: ['L','צורת מוטות אורך','','straight'], barSpacingDisplayMode: ['↔','מידת מרווח בחתך','','C/C'], lHookLength: ['L','אורך רגל L','ס״מ','25'],
      straightBarCount: ['N','מוטות ישרים (יח׳)','יח׳','5'], bentBarCount: ['N','מוטות מכופפים (יח׳)','יח׳','5'], straightBarLength: ['L','אורך ראשי (ס״מ)','ס״מ','1200'], bentBarLength: ['L','אורך מכופף כולל (ס״מ)','ס״מ','1220'], bendLength: ['↪','אורך כיפוף (ס״מ)','ס״מ','20'], bendAngle: ['∠','זווית כיפוף (מעלות)','°','90'], bendOrientationDeg: ['∠','כיוון הכיפוף סביב הכלוב','°','0 פנימה · 90 עם כיוון השעון'],
      spiralOuterDiameter: ['Ø','קוטר חיצוני ספירלה (ס״מ)','ס״מ','48'], spiralPitch: ['@','פסיעת ספירלה (ס״מ)','ס״מ','15'], hoopOuterDiameter: ['Ø','קוטר חיצוני טבעת (ס״מ)','ס״מ','42'], hoopQuantity: ['N','כמות טבעות (יח׳)','יח׳','לפי תכנון'],
    };
    const field = (key, min = 1) => {
      const m = meta[key] || ['•', key, 'מ״מ', '100'];
      const commit = key === 'pileLength' ? ' onchange="window._seEditor._renderPileCageEditor()"' : '';
      return '<td colspan="2">' + this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], focusKey:m[4], number:m[5], code:m[6], input:`<input class="se-input" type="number" min="${min}" value="${pile[key] ?? 0}" data-pile-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" oninput="window._seEditor._setPileField('${key}', this.value)"${commit}>` }) + '</td>';
    };
    const selectField = (key, options) => {
      const m = meta[key] || ['•', key, '', ''];
      const html = options.map(([value, label]) => `<option value="${value}" ${String(pile[key]) === String(value) ? 'selected' : ''}>${label}</option>`).join('');
      return '<td colspan="2">' + this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], input:`<select class="se-input" data-pile-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" onchange="window._seEditor._setPileField('${key}', this.value)">${html}</select>` }) + '</td>';
    };
    const checkboxField = (key) => {
      const m = meta[key] || ['•', key, '', ''];
      return '<td colspan="2">' + this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], input:`<input class="se-input" type="checkbox" ${pile[key] ? 'checked' : ''} data-pile-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" onchange="window._seEditor._setPileField('${key}', this.checked)">` }) + '</td>';
    };
    const compactField = (key, min = 1) => {
      const m = meta[key] || ['•', key, 'מ״מ', '100'];
      const commit = key === 'pileLength' ? ' onchange="window._seEditor._renderPileCageEditor()"' : '';
      return this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], focusKey:m[4], number:m[5], code:m[6], input:`<input class="se-input" type="number" min="${min}" value="${pile[key] ?? 0}" data-pile-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" oninput="window._seEditor._setPileField('${key}', this.value)"${commit}>` });
    };
    const compactSelect = (key, options) => {
      const m = meta[key] || ['•', key, '', ''];
      const html = options.map(([value, label]) => `<option value="${value}" ${String(pile[key]) === String(value) ? 'selected' : ''}>${label}</option>`).join('');
      return this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], input:`<select class="se-input" data-pile-field="${key}" onfocus="window._seEditor._focusFamilyField('${key}')" onchange="window._seEditor._setPileField('${key}', this.value)">${html}</select>` });
    };
    const bendOrientationField = () => {
      const m = meta.bendOrientationDeg;
      return this._fieldShell({ icon:m[0], label:m[1], unit:m[2], example:m[3], focusKey:'pile-bend-orientation', input:`<input class="se-input" type="text" inputmode="decimal" autocomplete="off" value="${svgEscape(pile.bendOrientationDeg ?? 0)}" data-pile-field="bendOrientationDeg" aria-label="כיוון הכיפוף במעלות" onfocus="window._seEditor._focusFamilyField('bendOrientationDeg')" oninput="window._seEditor._setPileField('bendOrientationDeg', this.value)">` });
    };
    if (pile.roundPileCage) {
      if (!Array.isArray(pile.spiralZones) || !pile.spiralZones.length) {
        pile.spiralZones = buildRoundPileCageStandardZones(pile.pileLength);
        this._pileCageTemplateMode = ROUND_PILE_CAGE_STANDARD_TEMPLATE;
      }
      if (!this._pileCageTemplateMode) {
        this._pileCageTemplateMode = matchesRoundPileCageStandardZones(pile) ? ROUND_PILE_CAGE_STANDARD_TEMPLATE : 'custom';
      }
      const calc = PileCageEngine.calculate(pile);
      const consolidatedSpiral = (calc.manufacturingBreakdown || []).find(part => part.componentType === 'spiral_consolidated');
      const spiralTurns = (consolidatedSpiral?.schedule || []).reduce((sum, zone) => sum + Number(zone.turns || 0), 0);
      const displaySpiralTurns = Number.isInteger(spiralTurns) ? String(spiralTurns) : spiralTurns.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      const allowedSections = new Set(['general', 'bars', 'spiral', 'hoops']);
      const activeSection = allowedSections.has(this._activePileSection) ? this._activePileSection : 'general';
      this._activePileSection = activeSection;
      const advanced = content => `<details class="se-pile-advanced"><summary tabindex="-1">⋯</summary><div class="se-pile-advanced-grid">${content}</div></details>`;
      const section = (id, title, summary, content) => `<section class="se-pile-section" data-pile-section="${id}"><header class="se-pile-section-head"><strong>${title}</strong><span data-pile-section-summary="${id}">${summary}</span></header><div class="se-pile-section-body">${content}</div></section>`;
      const segmentRows = pile.spiralZones.map((zone, index) => `<div class="se-zone-engineering-row" data-zone-index="${index}">
        <label><span>מקטע</span><input class="se-input" type="text" value="${svgEscape(zone.name || String.fromCharCode(65 + index))}" data-zone-field="name" aria-label="שם מקטע" onfocus="window._seEditor._focusFamilyField('pile-zone')" oninput="window._seEditor._setSpiralZoneField(${index}, 'name', this.value)"></label>
        <label><span>אורך <small>ס״מ</small></span><input class="se-input" type="number" min="0" value="${zone.length ?? 0}" data-zone-field="length" aria-label="אורך מקטע בסנטימטר" onfocus="window._seEditor._focusFamilyField('pile-zone')" oninput="window._seEditor._setSpiralZoneField(${index}, 'length', this.value)"></label>
        <label><span>@ <small>ס״מ</small></span><input class="se-input" type="number" min="1" value="${zone.noWrap ? '' : (zone.pitch ?? pile.spiralPitch ?? 20)}" ${zone.noWrap ? 'disabled' : ''} data-zone-field="pitch" aria-label="פסיעת מקטע בסנטימטר" onfocus="window._seEditor._focusFamilyField('pile-spiral-pitch')" oninput="window._seEditor._setSpiralZoneField(${index}, 'pitch', this.value)"></label>
        <label class="se-zone-nowrap"><input type="checkbox" ${zone.noWrap ? 'checked' : ''} data-zone-field="noWrap" onfocus="window._seEditor._focusFamilyField('pile-no-wrap')" onchange="window._seEditor._setSpiralZoneField(${index}, 'noWrap', this.checked)"><span>ללא כריכות</span></label>
        <button type="button" class="se-del-btn" aria-label="מחיקת מקטע" onclick="window._seEditor._deleteSpiralZone(${index})">&times;</button>
      </div>`).join('');
      const zoneQuick = pile.spiralZones.map((zone, index) => {
        const name = svgEscape(zone.name || String.fromCharCode(65 + index));
        return zone.noWrap ? `${name}: ${Number(zone.length || 0)} ס״מ ללא` : `${name}: ${Number(zone.length || 0)} ס״מ @ ${Number(zone.pitch || 0)} ס״מ`;
      }).join(' · ');
      const templateValue = this._pileCageTemplateMode === ROUND_PILE_CAGE_STANDARD_TEMPLATE ? ROUND_PILE_CAGE_STANDARD_TEMPLATE : 'custom';
      const straightCount = Number(pile.straightBarCount || 0);
      const bentCount = Number(pile.bentBarCount || 0);
      const sectionSummary = {
        general: `Ø${Number(pile.pileDiameter || 0)} · L ${Number(pile.pileLength || 0)} ס״מ`,
        bars: `${straightCount} ישר + ${bentCount} L · Ø${Number(pile.longitudinalDiameter || 0)} מ״מ`,
        spiral: `Ø${Number(pile.spiralDiameter || 0)} מ״מ · ${zoneQuick}`,
        hoops: `${Number(pile.hoopQuantity || 0)} × Ø${Number(pile.hoopDiameter || 0)} מ״מ · D${Number(pile.hoopOuterDiameter || 0)} ס״מ`,
      };
      const localizedValidation = (calc.validation?.errors || []).map(localizePileValidationError).filter(Boolean);
      const segmentTotalCm = pile.spiralZones.reduce((sum, zone) => sum + Math.max(0, Number(zone?.length || 0)), 0);
      if (segmentTotalCm > Number(pile.pileLength || 0)) localizedValidation.push('אורך המקטעים גדול מאורך הכלוב');
      const groupTabs = [
        ['general', 'כלוב', 'pileDiameter'],
        ['bars', 'זיון אורך', 'straightBarCount'],
        ['spiral', 'ספירלה', 'spiralDiameter'],
        ['hoops', 'טבעות', 'hoopQuantity'],
      ].map(([id, label, fieldKey]) => `<button type="button" class="se-pile-group-tab" data-pile-group-tab="${id}" aria-selected="${activeSection === id}" onclick="window._seEditor._activatePileCageField('${id}','${fieldKey}')">${label}</button>`).join('');
      const cageName = svgEscape(pile.structElement ?? this._pendingElementName ?? '');
      body.innerHTML = `
        <tr class="se-pile-engineering-grid-row"><td colspan="5">
          <nav class="se-pile-group-tabs" data-pile-quick-entry aria-label="קיצורי הזנה מהירה">${groupTabs}</nav>
          <div class="se-pile-engineering-grid">
            ${section('general', 'כלוב', sectionSummary.general, `<div class="se-pile-identity-grid"><div class="se-pile-name-field"><label>סימון</label><input type="text" value="${cageName}" data-pile-element-name autocomplete="off" placeholder="A / P-01" oninput="window._seEditor._setElementName(this.value)"></div>${compactField('pileDiameter', 1)}${compactField('pileLength', 1)}</div>${advanced(`<div class="se-pile-template-row"><label>תבנית<select data-pile-template onchange="window._seEditor._applyPileCageTemplate(this.value)"><option value="${ROUND_PILE_CAGE_STANDARD_TEMPLATE}" ${templateValue === ROUND_PILE_CAGE_STANDARD_TEMPLATE ? 'selected' : ''}>סטנדרטית</option><option value="custom" ${templateValue === 'custom' ? 'selected' : ''}>מותאמת</option></select></label></div>`)}<div class="se-pile-inline-error" data-pile-errors="general"></div>`)}
            ${section('bars', 'זיון אורך', sectionSummary.bars, `<div class="se-pile-bars-grid">${compactField('straightBarCount', 0)}${compactField('bentBarCount', 0)}${compactField('longitudinalDiameter', 1)}${compactField('straightBarLength', 1)}${compactField('bendLength', 0)}${compactField('bendAngle', 0)}${bendOrientationField()}${compactSelect('barSpacingDisplayMode', [['center','C/C'], ['clear','CLEAR']])}</div>`)}
            ${section('spiral', 'ספירלה', sectionSummary.spiral, `<div class="se-pile-spiral-head">${compactField('spiralDiameter', 1)}${compactField('spiralOuterDiameter', 1)}<div class="se-derived-chip" data-pile-derived="spiralTurns">${displaySpiralTurns} ↻</div></div><div class="se-zone-engineering-grid">${segmentRows}</div><button type="button" class="se-add-btn se-zone-add" onclick="window._seEditor._addSpiralZone()">+ מקטע</button><div class="se-pile-inline-error" data-pile-errors="spiral"></div>`)}
            ${section('hoops', 'טבעות', sectionSummary.hoops, `<div class="se-pile-hoops-grid">${compactField('hoopQuantity', 0)}${compactField('hoopDiameter', 1)}${compactField('hoopOuterDiameter', 1)}${compactField('hoopStart', 0)}${compactField('hoopSpacing', 1)}</div><div class="se-pile-inline-error" data-pile-errors="hoops">${localizedValidation.join(' · ')}</div>`)}
          </div>
        </td></tr>`;
      this._syncPileActiveSection();
      this._bindPileKeyboardFlow();
      return;
    }
    const hoopRow = () => `<tr class="se-family-row se-pile-hoop-row"><td colspan="5"><div class="se-pile-hoop-grid" data-pile-hoop-row><label class="se-pile-hoop-toggle" title="טבעות פנימיות"><input type="checkbox" ${pile.hoopsEnabled ? 'checked' : ''} data-pile-field="hoopsEnabled" onchange="window._seEditor._setPileField('hoopsEnabled', this.checked)"></label>${compactField('hoopDiameter', 14)}${compactField('hoopSpacing', 1)}${compactField('hoopStart', 0)}${compactField('hoopEnd', 0)}${compactSelect('hoopStartSide', [['start','מהתחלה'], ['end','מהסוף']])}${compactSelect('hoopShape', [['round','עגול'], ['hex','משושה'], ['oct','מתומן']])}<div class="se-derived-chip" data-pile-derived="internalHoopDiameter" title="קוטר טבעת פנימי מחושב">Ø${internalHoopDiameterCm}</div><div class="se-derived-chip" data-pile-derived="barCenterSpacing" title="מרחק אווירי מרכז-מרכז בין מוטות">מ-מ ${barCenterSpacingCm}</div><div class="se-derived-chip" data-pile-derived="barClearSpacing" title="מרחק אווירי נקי בין מוטות">נקי ${barClearSpacingCm}</div></div></td></tr>`;
    const pileDiameterMmForDerived = pileCmToMm(pile.pileDiameter || 70, 700);
    const coverMmForDerived = pileCmToMm(pile.concreteCover || 0, 0);
    const internalHoopDiameterMmForDerived = pileInternalHoopDiameterMm({ pileDiameter: pileDiameterMmForDerived, concreteCover: coverMmForDerived, spiralDiameter: pile.spiralDiameter || 8, longitudinalDiameter: pile.longitudinalDiameter || 22 });
    const internalHoopDiameterCm = pileRound(internalHoopDiameterMmForDerived / 10, 1);
    const barSpacingForDerived = pileLongitudinalSpacingMm(internalHoopDiameterMmForDerived, pile.longitudinalBars || 0, pile.longitudinalDiameter || 22);
    const barCenterSpacingCm = pileRound(barSpacingForDerived.centerToCenterMm / 10, 1);
    const barClearSpacingCm = pileRound(barSpacingForDerived.clearMm / 10, 1);
    const zoneRows = pile.spiralZones.map((zone, i) => `
      <tr class="se-family-row se-zone-row">
        <td>${this._fieldShell({ icon:'Z', label:'שם אזור', unit:'טקסט', example:'A', input:`<input class="se-input" type="text" value="${svgEscape(zone.name || 'Zone ' + String.fromCharCode(65 + i))}" data-zone-field="name" onfocus="window._seEditor._focusFamilyField('zone')" oninput="window._seEditor._setSpiralZoneField(${i}, 'name', this.value)">` })}</td>
        <td>${this._fieldShell({ icon:'↔', label:'אורך', unit:'ס״מ', example:'70', input:`<input class="se-input" type="number" min="0" value="${zone.length ?? 0}" data-zone-field="length" onfocus="window._seEditor._focusFamilyField('zoneLength')" oninput="window._seEditor._setSpiralZoneField(${i}, 'length', this.value)">` })}</td>
        <td>${this._fieldShell({ icon:'@', label:'פסיעה', unit:'ס״מ', example:'20', input:`<input class="se-input" type="number" min="1" value="${zone.noWrap ? '' : (zone.pitch ?? 20)}" ${zone.noWrap ? 'disabled' : ''} data-zone-field="pitch" onfocus="window._seEditor._focusFamilyField('zonePitch')" oninput="window._seEditor._setSpiralZoneField(${i}, 'pitch', this.value)">` })}</td>
        <td>${this._fieldShell({ icon:'—', label:'ללא כריכות', unit:'', example:'כן/לא', input:`<input class="se-input" type="checkbox" ${zone.noWrap ? 'checked' : ''} data-zone-field="noWrap" onfocus="window._seEditor._focusFamilyField('noWrap')" onchange="window._seEditor._setSpiralZoneField(${i}, 'noWrap', this.checked)">` })}</td>
        <td><button class="se-del-btn" onclick="window._seEditor._deleteSpiralZone(${i})">&times;</button></td>
      </tr>`).join('');
    const calc = PileCageEngine.calculate(pile);
    const hoopCount = Array.isArray(calc.manufacturingBreakdown) ? (calc.manufacturingBreakdown.find(part => part.componentType === 'hoop_ring')?.quantity || 0) : 0;
    const spiralPitchSummary = (pile.spiralZones || []).filter(z => !z.noWrap).map(z => Number(z.pitch || 0)).filter(Boolean).pop() || 0;
    const validationRows = [];
    if (!Number(pile.pileDiameter || 0)) validationRows.push(['error', 'חסר קוטר כלונס']);
    if (!Number(pile.pileLength || 0)) validationRows.push(['error', 'חסר אורך כלונס']);
    if (!Number(pile.longitudinalBars || 0)) validationRows.push(['error', 'אין מוטות אורך']);
    if (!(pile.spiralZones || []).length) validationRows.push(['warning', 'אין אזורי ספירלה']);
    const validationHtml = validationRows.length
      ? validationRows.map(([kind, msg]) => `<div class="se-pile-validation ${kind}">${msg}</div>`).join('')
      : '<div class="se-pile-validation ok">הנתונים תקינים לעריכה</div>';
    const sectionSummary = {
      general: `קוטר ${pile.pileDiameter || 0} ס״מ | אורך ${pile.pileLength || 0} ס״מ`,
      bars: `${pile.longitudinalBars || 0} מוטות | Ø${pile.longitudinalDiameter || 0} מ״מ | ${pile.barPattern || 'ישר'}`,
      spiral: `Ø${pile.spiralDiameter || 0} מ״מ | פסיעה ${spiralPitchSummary || '-'} ס״מ | ${(pile.spiralZones || []).length} אזורים`,
      hoops: `${pile.hoopsEnabled ? 'פעיל' : 'כבוי'} | Ø${pile.hoopDiameter || 0} מ״מ | ${hoopCount} יח׳`,
      breakdown: `${(calc.manufacturingBreakdown || []).length} רכיבים | ${pileRound(calc.weightKg || 0, 2)} ק״ג`,
      validation: validationRows.length ? `${validationRows.length} הערות` : 'תקין',
    };
    const pileSection = (id, title, summary, rows, open = false, focusKey = '') => `<tr class="se-pile-section-row"><td colspan="5"><details class="se-pile-section" data-pile-section="${id}" ${open ? 'open' : ''}><summary onclick="window._seEditor && window._seEditor._focusFamilyField('${focusKey || id}')"><strong>${title}</strong><span>${summary}</span></summary><table><tbody>${rows}</tbody></table></details></td></tr>`;
    body.innerHTML = `
      ${pileSection('general', 'כללי', sectionSummary.general, `<tr class="se-family-row se-pile-compact-row">${field('pileDiameter', 1)}${field('pileLength', 1)}</tr>`, true, 'pile-diameter')}
      ${pileSection('bars', 'מוטות אורך', sectionSummary.bars, `<tr class="se-family-row se-pile-compact-row">${field('longitudinalBars', 0)}${field('longitudinalDiameter', 1)}</tr><tr class="se-family-row se-pile-compact-row">${selectField('barPattern', [['straight','ישר'], ['l','L'], ['alternate','משולב'], ['manual','ידני']])}${selectField('barSpacingDisplayMode', [['center','C/C'], ['clear','CLEAR']])}</tr>${this._renderPileLongitudinalShapeRows(field)}`, true, 'pile-longitudinal-bars')}
      ${pileSection('spiral', 'ספירלה', sectionSummary.spiral, `<tr class="se-family-row se-pile-compact-row">${field('spiralDiameter', 1)}${selectField('spiralType', [['continuous','רציפה'], ['zoned','אזורים'], ['segmented','מקטעים']])}</tr><tr class="se-zone-head se-zone-row"><td>שם אזור</td><td>אורך אזור</td><td>פסיעה</td><td>ללא כריכות</td><td></td></tr>${zoneRows}<tr class="se-family-row se-pile-action-row"><td colspan="5"><button class="se-add-btn" onclick="window._seEditor._addSpiralZone()">הוסף אזור</button></td></tr>`, false, 'pile-spiral-pitch')}
      ${pileSection('hoops', 'טבעות / חישוקים', sectionSummary.hoops, hoopRow(), false, 'pile-hoops')}
      ${pileSection('breakdown', 'פירוק לייצור', sectionSummary.breakdown, this._renderPileElementsSummary(), false, 'pile-longitudinal-bars')}
      ${pileSection('validation', 'בדיקות / שגיאות', sectionSummary.validation, `<tr class="se-family-row"><td colspan="5"><div class="se-pile-validations">${validationHtml}</div></td></tr>`, false, 'pile-zone')}`;  }

  _renderPileLongitudinalShapeRows(field) {
    const pile = this.current || {};
    const pattern = String(pile.barPattern || 'straight');
    const shell = (title, desc, body) => `<td colspan="5"><div class="se-pile-bar-editor" data-pile-bar-editor="${svgEscape(title)}"><div class="se-pile-bar-editor-head"><strong>${title}</strong><span>${desc}</span></div>${body}</div></td>`;
    const overrideRows = this._renderPileBarOverrideRows();
    if (pattern === 'straight') {
      return `<tr class="se-family-row se-pile-bar-shape-row">${shell('מוטות אורך', 'ברירת מחדל: ישרים בקוטר אחיד', '<span class="se-pile-bar-note">שנה רק חריגים: מוט מסוים עם קוטר אחר או צורת L.</span>' + overrideRows)}</tr>`;
    }
    if (pattern === 'l') {
      return `<tr class="se-family-row se-pile-bar-shape-row">${shell('מוטות L', 'כל המוטות בצורת L', '<div class="se-pile-inline-field">' + field('lHookLength', 0) + field('bendAngle', 0) + '</div>' + overrideRows)}</tr>`;
    }
    if (pattern === 'alternate') {
      return `<tr class="se-family-row se-pile-bar-shape-row">${shell('מוטות משולבים', 'ברירת מחדל: לסירוגין ישר / L', '<div class="se-pile-inline-field">' + field('lHookLength', 0) + field('bendAngle', 0) + '</div>' + overrideRows)}</tr>`;
    }
    return `<tr class="se-family-row se-pile-bar-shape-row">${shell('עריכת מוטות אורך', 'חריגים לפי מספר מוט', overrideRows)}</tr>`;
  }

  _renderPileBarOverrideRows() {
    const pile = this.current || {};
    const totalBars = Math.max(0, Math.round(Number(pile.longitudinalBars || 0)));
    pile.longitudinalBarOverrides = normalizePileBarOverrides(pile.longitudinalBarOverrides || [], totalBars);
    const options = (value) => `<option value="straight" ${value === 'straight' ? 'selected' : ''}>ישר</option><option value="l" ${value === 'l' ? 'selected' : ''}>L</option>`;
    const rows = pile.longitudinalBarOverrides.map((entry, i) => `
      <div class="se-pile-bar-override-row" data-pile-bar-override="${i}">
        <label>מוט<input class="se-input" type="number" min="1" max="${Math.max(1, totalBars)}" value="${entry.barIndex}" data-pile-bar-field="barIndex" oninput="window._seEditor._setPileBarOverrideField(${i}, 'barIndex', this.value)"></label>
        <label>קוטר<input class="se-input" type="number" min="1" value="${entry.diameter || pile.longitudinalDiameter || 22}" data-pile-bar-field="diameter" oninput="window._seEditor._setPileBarOverrideField(${i}, 'diameter', this.value)"></label>
        <label>צורה<select class="se-input" data-pile-bar-field="barPattern" onchange="window._seEditor._setPileBarOverrideField(${i}, 'barPattern', this.value)">${options(entry.barPattern || 'straight')}</select></label>
        <label>רגל L<input class="se-input" type="number" min="0" value="${entry.lHookLength || 0}" data-pile-bar-field="lHookLength" oninput="window._seEditor._setPileBarOverrideField(${i}, 'lHookLength', this.value)"></label>
        <button class="se-del-btn" onclick="window._seEditor._deletePileBarOverride(${i})">&times;</button>
      </div>`).join('');
    return `<div class="se-pile-bar-overrides">${rows}<button class="se-add-btn se-pile-add-override" onclick="window._seEditor._addPileBarOverride()">הוסף עריכת מוט</button></div>`;
  }

  _pileElementLabel(part) {
    const type = String(part?.componentType || '');
    if (type === 'longitudinal_l_bar') return 'מוטות אורך L';
    if (type === 'longitudinal_straight_bar') return 'מוטות אורך ישרים';
    if (type === 'spiral_consolidated') return 'ספירלה';
    if (type === 'hoop_ring') return 'טבעות חיזוק';
    return part?.description || type || 'רכיב';
  }

  _pileComponentCardsHtml() {
    const pile = this.current || {};
    const calc = PileCageEngine.calculate(pile);
    const parts = calc.manufacturingBreakdown || [];
    const format = (value, digits = 3) => {
      const number = Number(value || 0);
      return Number.isInteger(number) ? String(number) : number.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
    };
    return parts.map((part) => {
      const type = String(part.componentType || 'part');
      const title = svgEscape(this._pileElementLabel(part));
      const quantity = Number(part.quantity ?? 1);
      const diameterMm = Number(part.diameterMm || 0);
      let section = 'bars';
      let field = 'straightBarLength';
      let visual = '';
      let metrics = [];
      if (type === 'longitudinal_straight_bar') {
        const sidesMm = (part.sides || [part.unitLengthMm || 0]).map(value => Number(value || 0));
        visual = PolylineBarEngine.render({ sides: sidesMm, angles: [] }, 112, 90, { padding: 18 });
        metrics = [`${quantity} × Ø${format(diameterMm)} mm`, `L ${format(Number(part.unitLengthMm || 0) / 10)} cm`];
      } else if (type === 'longitudinal_l_bar') {
        section = 'bars'; field = 'bendLength';
        const sidesMm = (part.sides || []).map(value => Number(value || 0));
        visual = PolylineBarEngine.render({ sides: sidesMm, angles: part.angles || [90] }, 112, 90, { padding: 18 });
        const sidesCm = sidesMm.map(value => value / 10);
        metrics = [`${quantity} × Ø${format(diameterMm)} mm`, `${sidesCm.map(value => format(value)).join(' + ')} cm`, `${format(Number(part.angles?.[0] || 90))}°`];
      } else if (type === 'spiral_consolidated') {
        section = 'spiral'; field = 'spiralDiameter';
        const turns = (part.schedule || []).reduce((sum, zone) => sum + Number(zone?.turns || 0), 0);
        visual = SpiralEngine.render({ barDiameter: diameterMm, spiralDiameter: Number(part.outerDiameterMm || 0), turns }, 112, 90);
        // The component card intentionally carries only these four production
        // values. Segment order, pitch and no-wrap remain on the complete cage.
        metrics = [`Ø${format(diameterMm)} mm`, `D ${format(Number(part.outerDiameterMm || 0) / 10)} cm`, `${format(turns)} ↻`, `CUT ${format(Number(part.totalLengthMm || 0) / 10)} cm`];
      } else if (type === 'hoop_ring') {
        section = 'hoops'; field = 'hoopOuterDiameter';
        visual = RingEngine.render({ barDiameterMm: diameterMm, bendingDiameterMm: Number(part.bendingDiameterMm || part.hoopOuterDiameterMm || 0), overlapMm: 0 }, 112, 90);
        metrics = [`${quantity} × Ø${format(diameterMm)} mm`, `D ${format(Number(part.bendingDiameterMm || part.hoopOuterDiameterMm || 0) / 10)} cm`, `L ${format(Number(part.unitLengthMm || 0) / 10)} cm`];
      }
      const focusKey = type === 'longitudinal_straight_bar' ? 'pile-longitudinal-bars'
        : type === 'longitudinal_l_bar' ? 'pile-l-bars'
          : type === 'spiral_consolidated' ? 'pile-spiral-diameter'
            : 'pile-hoops';
      const active = this._activePileComponent === type;
      return `<article class="se-pile-component-card" role="button" tabindex="0" aria-pressed="${active}" data-pile-component-card="${svgEscape(type)}" data-pile-component-section="${section}" data-pile-component-focus="${focusKey}" data-active="${active}" onpointerdown="event.preventDefault();window._seEditor?._activatePileComponentCard(this)" onclick="window._seEditor?._activatePileComponentCard(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window._seEditor?._activatePileComponentCard(this)}"><span class="se-pile-component-visual"><svg viewBox="0 0 112 90" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${visual}</svg></span><span class="se-pile-component-copy"><span class="se-pile-component-card-title">${title}</span><span class="se-pile-component-metrics">${metrics.map(metric => `<span class="se-pile-component-metric">${svgEscape(metric)}</span>`).join('')}</span></span></article>`;
    }).join('');
  }

  _pileElementsSummaryHtml() {
    const cards = this._pileComponentCardsHtml();
    return cards
      ? `<div class="se-pile-component-cards" data-pile-component-cards>${cards}</div>`
      : '<span class="se-pile-bar-note">אין רכיבי ייצור מחושבים</span>';
  }

  _refreshPileComponentGallery() {
    const gallery = document.getElementById('sePileComponentGallery');
    if (!gallery) return;
    const visible = Boolean(this.current?.roundPileCage);
    gallery.hidden = !visible;
    const cards = visible ? this._pileComponentCardsHtml() : '';
    const shouldReplace = gallery !== this._pileComponentGalleryHost || cards !== this._pileComponentGalleryHtml;
    if (shouldReplace) {
      gallery.innerHTML = cards;
      this._pileComponentGalleryHost = gallery;
      this._pileComponentGalleryHtml = cards;
    }
    if (visible && shouldReplace) {
      // The form's focusout refreshes the preview.  Activate on pointerdown at
      // the stable gallery parent so that refresh cannot replace the card
      // between mousedown and click.
      gallery.onpointerdown = event => {
        if (event.button !== 0) return;
        const card = event.target.closest('[data-pile-component-card]');
        if (!card) return;
        event.preventDefault();
        this._activatePileComponentCard(card);
      };
      gallery.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('[data-pile-component-card]');
        if (!card) return;
        event.preventDefault();
        this._activatePileComponentCard(card);
      };
    } else if (!visible && shouldReplace) {
      gallery.onpointerdown = null;
      gallery.onkeydown = null;
    }
    if (visible) this._syncPileActiveSection();
  }

  _activatePileComponentCard(card) {
    if (!card || !this.current?.roundPileCage) return;
    this._activePileComponent = String(card.dataset.pileComponentCard || '');
    this._activePileSection = String(card.dataset.pileComponentSection || 'general');
    this._syncPileActiveSection();
    this._focusFamilyField(String(card.dataset.pileComponentFocus || this._activePileSection));
  }

  _renderPileElementsSummary() {
    return `<tr class="se-family-row se-pile-elements-row"><td colspan="5"><div class="se-pile-elements" data-pile-elements-summary><div class="se-pile-elements-head">רכיבי הכלוב — כל פריט בנפרד<span>כמות, מידה ומיקום</span></div><div data-pile-elements-body>${this._pileElementsSummaryHtml()}</div></div></td></tr>`;
  }

  _refreshPileElementsSummary() {
    if (!this.current || this.current.family !== 'piles') return;
    const body = document.querySelector('[data-pile-elements-body]');
    if (body) body.innerHTML = this._pileElementsSummaryHtml();
  }

  _setPileBarOverrideField(index, key, val) {
    if (!this.current || this.current.family !== 'piles') return;
    if (!Array.isArray(this.current.longitudinalBarOverrides)) this.current.longitudinalBarOverrides = [];
    const row = this.current.longitudinalBarOverrides[index];
    if (!row) return;
    if (key === 'barPattern') row[key] = String(val || 'straight') === 'l' ? 'l' : 'straight';
    else row[key] = Math.max(key === 'lHookLength' ? 0 : 1, Math.round(Number(val) || 0));
    this.current.longitudinalBarOverrides = normalizePileBarOverrides(this.current.longitudinalBarOverrides, this.current.longitudinalBars || 0);
    this._refreshPileElementsSummary();
    this._updatePreview();
  }

  _addPileBarOverride() {
    if (!this.current || this.current.family !== 'piles') return;
    if (!Array.isArray(this.current.longitudinalBarOverrides)) this.current.longitudinalBarOverrides = [];
    const totalBars = Math.max(1, Math.round(Number(this.current.longitudinalBars || 1)));
    const used = new Set(this.current.longitudinalBarOverrides.map(row => Math.round(Number(row.barIndex || 0))));
    let barIndex = 1;
    while (used.has(barIndex) && barIndex < totalBars) barIndex += 1;
    this.current.longitudinalBarOverrides.push({ barIndex, diameter: Math.max(1, Number(this.current.longitudinalDiameter || 22)), barPattern: 'straight', lHookLength: 0 });
    this._renderPileCageEditor();
    this._updatePreview();
  }

  _deletePileBarOverride(index) {
    if (!this.current || this.current.family !== 'piles' || !Array.isArray(this.current.longitudinalBarOverrides)) return;
    this.current.longitudinalBarOverrides.splice(index, 1);
    this._renderPileCageEditor();
    this._updatePreview();
  }

  _refreshPileDerived() {
    if (!this.current || this.current.family !== 'piles') return;
    const diameterOut = document.querySelector('[data-pile-derived="internalHoopDiameter"]');
    const centerOut = document.querySelector('[data-pile-derived="barCenterSpacing"]');
    const clearOut = document.querySelector('[data-pile-derived="barClearSpacing"]');
    const spiralTurnsOut = document.querySelector('[data-pile-derived="spiralTurns"]');
    if (!diameterOut && !centerOut && !clearOut && !spiralTurnsOut) return;
    const pile = this.current;
    const pileDiameterMm = pileCmToMm(pile.pileDiameter || 70, 700);
    const coverMm = pileCmToMm(pile.concreteCover || 0, 0);
    const internalHoopDiameterMm = pileInternalHoopDiameterMm({ pileDiameter: pileDiameterMm, concreteCover: coverMm, spiralDiameter: pile.spiralDiameter || 8, longitudinalDiameter: pile.longitudinalDiameter || 22 });
    const internalHoopDiameterCm = pileRound(internalHoopDiameterMm / 10, 1);
    const spacing = pileLongitudinalSpacingMm(internalHoopDiameterMm, pile.longitudinalBars || 0, pile.longitudinalDiameter || 22);
    const centerCm = pileRound(spacing.centerToCenterMm / 10, 1);
    const clearCm = pileRound(spacing.clearMm / 10, 1);
    if (diameterOut) {
      if ('value' in diameterOut) diameterOut.value = internalHoopDiameterCm;
      diameterOut.textContent = diameterOut.classList && diameterOut.classList.contains('se-derived-chip') ? `?${internalHoopDiameterCm}` : internalHoopDiameterCm;
    }
    if (centerOut) {
      if ('value' in centerOut) centerOut.value = centerCm;
      centerOut.textContent = centerOut.classList && centerOut.classList.contains('se-derived-chip') ? `מרכז-מרכז ${centerCm} ס״מ` : centerCm;
    }
    if (clearOut) {
      if ('value' in clearOut) clearOut.value = clearCm;
      clearOut.textContent = clearOut.classList && clearOut.classList.contains('se-derived-chip') ? `מרווח נקי ${clearCm} ס״מ` : clearCm;
    }
    if (spiralTurnsOut && pile.roundPileCage) {
      const turns = (Array.isArray(pile.spiralZones) ? pile.spiralZones : []).reduce((sum, zone) => {
        if (zone?.noWrap) return sum;
        return sum + Math.max(0, Number(zone?.length) || 0) / Math.max(1, Number(zone?.pitch || pile.spiralPitch || 1));
      }, 0);
      const displayTurns = Number.isInteger(turns) ? String(turns) : turns.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      spiralTurnsOut.textContent = `${displayTurns} ↻`;
    }
  }

  _renderBarEditor() {
    if (!this.current) return;
    this._setFamilyEditorChrome('bars');
    let { sides, angles, azAngles, elAngles } = this.current;
    const isReal3D = this.current.is3d === 1 || this.current.is3d === true;
    if (isReal3D && angles?.length > 0 && (!azAngles || azAngles.every(a => Number(a || 0) === 0))) {
      this._init3DAnglesFrom2D(false);
      ({ sides, angles, azAngles, elAngles } = this.current);
    }
    const isStraightBar = !isReal3D && Array.isArray(sides) && sides.length === 1 && (!Array.isArray(angles) || angles.length === 0);
    const addRow = document.querySelector('#seModal .se-add-row');
    const addButton = document.getElementById('seAddSide');
    if (addRow) addRow.style.display = '';
    if (addButton) addButton.textContent = isStraightBar ? '+ \u05d4\u05d5\u05e1\u05e3 \u05e6\u05dc\u05e2 / \u05db\u05d9\u05e4\u05d5\u05e3' : '+ \u05d4\u05d5\u05e1\u05e3 \u05e6\u05dc\u05e2';
    // All bars — straight or bent — use one layout: the side table plus a
    // diameter and quantity field in the footer. A straight bar is simply a
    // one-side bar, so it renders here too (no separate English mini-form).
    this.current.family = 'bars';
    // Diameter and quantity start empty (0) so the operator must enter them;
    // confirm is blocked while either is 0.
    this.current.diameter = Number(this.current.diameter) || 0;
    this.current.quantity = Math.max(0, Number(this.current.quantity ?? this._pendingQuantity ?? 0) || 0);
    if (!Array.isArray(sides) || !sides.length) {
      this.current.sides = [1000];
      this.current.angles = [];
      ({ sides, angles } = this.current);
    }
    const toggle = document.getElementById('seReal3DToggle');
    if (toggle) toggle.checked = isReal3D;
    const help = document.getElementById('se3DHelp');
    if (help) help.textContent = isReal3D
      ? 'מוצר תלת-ממדי אמיתי: ערוך פנייה והטיית Z לכל צלע.'
      : '3D הוא תצוגה בלבד. סמן רק אם הברזל באמת יוצא מהמישור.';

    const thead = document.getElementById('seTableHead');
    const table = document.querySelector('#seModal .se-table');
    if (table) {
      table.classList.toggle('se-table-3d', isReal3D);
      table.classList.toggle('se-table-2d', !isReal3D);
    }
    if (thead) {
      thead.style.display = '';
      if (isReal3D) {
        thead.innerHTML = `<tr>
          <th style="width:28px">#</th>
          <th style="min-width:90px">אורך</th>
          <th>פנייה</th>
          <th>הטיית Z</th>
          <th style="width:28px"></th>
        </tr>`;
      } else {
        thead.innerHTML = `<tr>
          <th style="width:32px">#</th>
          <th>אורך צלע (ס״מ)</th>
          <th>זווית כיפוף</th>
          <th style="width:32px"></th>
        </tr>`;
      }
    }

    // One-row side editor: each side keeps length and bend angle in one readable row.
    let html = '';
    for (let i = 0; i < sides.length; i++) {
      const letter = String.fromCharCode(65 + i);
      if (isReal3D) {
        const az = azAngles?.[i] ?? 0;
        const el = elAngles?.[i] ?? 0;
        html += `
          <tr>
            <td><span class="se-seg-label">${i + 1}</span></td>
            <td>${this._fieldShell({ icon:'📏', label:'אורך', unit:'ס״מ', example:'לדוגמה 30', input:`<input class="se-input" type="number" min="1" max="2000" value="${sides[i] / 10}" data-side="${i}" onfocus="window._seEditor._focusRow(${i}, false)" oninput="window._seEditor._setSide(${i}, this.value)" onblur="window._seEditor._finalizeSideInput(this, ${i})">` })}</td>
            <td>
              ${i === 0
                ? `<span class="se-no-bend">&mdash;</span>`
                : this._fieldShell({ icon:'↪', label:'פנייה', unit:'°', example:'לדוגמה 90', input:`<input class="se-input" type="number" min="-360" max="360" value="${az}" data-az="${i}" onfocus="window._seEditor._focusRow(${i}, true)" oninput="window._seEditor._setAzAngle(${i}, this.value)" onblur="window._seEditor._finalizeAngleInput(this, ${i}, 'az')">` })}
            </td>
            <td>
              ${this._fieldShell({ icon:'Z', label:'הטיית Z', unit:'°', example:'לדוגמה 0', input:`<input class="se-input" type="number" min="-90" max="90" value="${el}" data-el="${i}" onfocus="window._seEditor._focusRow(${i}, 'z')" oninput="window._seEditor._setElAngle(${i}, this.value)" onblur="window._seEditor._finalizeAngleInput(this, ${i}, 'el')">` })}
            </td>
            <td>${sides.length > 1 ? `<button class="se-del-btn" onclick="window._seEditor._deleteSide(${i})">&times;</button>` : ''}</td>
          </tr>`;
      } else {
        html += `
          <tr class="se-side-row">
            <td><span class="se-seg-label">${letter}</span></td>
            <td class="se-length-cell">${this._fieldShell({ icon:'📏', label:'אורך', unit:'ס״מ', example:'לדוגמה 30', input:`<input class="se-input" type="number" min="1" max="2000" value="${sides[i] / 10}" data-side="${i}" onfocus="window._seEditor._focusRow(${i}, false)" oninput="window._seEditor._setSide(${i}, this.value)" onblur="window._seEditor._finalizeSideInput(this, ${i})">` })}</td>
            <td class="se-angle-cell ${i < angles.length ? '' : 'se-empty-cell'}">${i < angles.length
              ? this._fieldShell({ icon:'∠', label:'זווית', unit:'°', example:'לדוגמה 90', input:`<input class="se-input" type="number" min="-360" max="360" value="${angles[i]}" data-angle="${i}" onfocus="window._seEditor._focusRow(${i}, true)" oninput="window._seEditor._setAngle(${i}, this.value)" onblur="window._seEditor._finalizeAngleInput(this, ${i}, 'bend')">` })
              : '<span class="se-no-bend">&mdash;</span>'}</td>
            <td>${sides.length > 1 ? `<button class="se-del-btn" onclick="window._seEditor._deleteSide(${i})">&times;</button>` : ''}</td>
          </tr>`;
      }
    }
    document.getElementById('seTableBody').innerHTML = html;
  }

  _setMeshField(key, val) {
    if (!this.current || this.current.family !== 'mesh') return;
    const min = key === 'edgeLeft' || key === 'edgeRight' || key === 'edgeTop' || key === 'edgeBottom' ? 0 : 1;
    const isSteelDiameter = key === 'longitudinalDiameter' || key === 'transverseDiameter';
    this.current[key] = isSteelDiameter
      ? Math.max(min, Number(val) || min)
      : Math.max(min, (Number(val) || min / 10) * 10);
    this._updatePreview();
  }

  _applyPileCageTemplate(mode) {
    if (!this.current?.roundPileCage) return;
    if (mode === ROUND_PILE_CAGE_STANDARD_TEMPLATE) {
      this.current.spiralZones = buildRoundPileCageStandardZones(this.current.pileLength);
      this.current.spiralType = 'zoned';
      this.current.spiralPitch = 20;
      this._pileCageTemplateMode = ROUND_PILE_CAGE_STANDARD_TEMPLATE;
    } else {
      this._pileCageTemplateMode = 'custom';
    }
    this._renderPileCageEditor();
    this._updatePreview();
  }

  _syncPileActiveSection() {
    if (!this.current?.roundPileCage) return;
    const labels = { general: 'כלוב', bars: 'זיון אורך', spiral: 'ספירלה', hoops: 'טבעות' };
    const sectionId = labels[this._activePileSection] ? this._activePileSection : 'general';
    this._activePileSection = sectionId;
    document.querySelectorAll('#seModal .se-pile-section').forEach(section => {
      section.dataset.active = String(section.dataset.pileSection === sectionId);
      const row = section.closest('[data-pile-section-row]');
      if (row) row.hidden = false;
    });
    document.querySelectorAll('#seModal [data-pile-group-tab]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.pileGroupTab === sectionId));
    });
    document.querySelectorAll('#seModal [data-pile-component-section]').forEach(card => {
      const selected = card.dataset.pileComponentCard === this._activePileComponent;
      card.dataset.active = String(selected);
      card.setAttribute('aria-pressed', String(selected));
    });
    const title = document.getElementById('seDataPanelTitle');
    if (title) title.textContent = 'הזנה מהירה';
    const modal = document.getElementById('seModal');
    if (modal) modal.dataset.pileActiveSection = sectionId;
  }

  _bindPileKeyboardFlow() {
    const body = document.getElementById('seTableBody');
    if (!body || !this.current?.roundPileCage) return;
    body.onkeydown = event => {
      const target = event.target;
      if (!target?.matches?.('input,select')) return;
      if (event.key !== 'Enter' || target.type === 'checkbox') return;
      const controls = [...body.querySelectorAll('input:not([disabled]),select:not([disabled])')]
        .filter(control => control.offsetParent !== null && !control.closest('.se-pile-advanced:not([open])'));
      const index = controls.indexOf(target);
      const next = controls[index + 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.select?.();
    };
  }

  _showPileInputError(message = '', input = null) {
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    const output = input?.closest?.('[data-pile-section]')?.querySelector?.('[data-pile-errors]')
      || document.querySelector('[data-pile-errors]');
    if (output) output.textContent = message;
  }

  _refreshRoundPileValidation() {
    if (!this.current?.roundPileCage) return;
    const pile = this.current;
    const calc = PileCageEngine.calculate(pile);
    const buckets = { general: [], spiral: [], hoops: [] };
    (calc.validation?.errors || []).forEach(error => {
      const raw = String(error || '');
      const bucket = /hoop/i.test(raw) ? 'hoops' : /spiral|pitch|wrapped|segment/i.test(raw) ? 'spiral' : 'general';
      buckets[bucket].push(localizePileValidationError(raw));
    });
    const segmentTotalCm = (pile.spiralZones || []).reduce((sum, zone) => sum + Math.max(0, Number(zone?.length || 0)), 0);
    if (segmentTotalCm > Number(pile.pileLength || 0)) {
      buckets.spiral.push(`אורך המקטעים ${segmentTotalCm} ס״מ גדול מאורך הכלוב ${Number(pile.pileLength || 0)} ס״מ`);
    }
    Object.entries(buckets).forEach(([section, messages]) => {
      const output = document.querySelector(`[data-pile-errors="${section}"]`);
      if (output) output.textContent = messages.filter(Boolean).join(' · ');
    });
    const invalidFields = {
      general: ['pileDiameter', 'pileLength'],
      spiral: ['spiralDiameter', 'spiralOuterDiameter'],
      hoops: ['hoopQuantity', 'hoopStart', 'hoopSpacing'],
    };
    Object.entries(invalidFields).forEach(([section, fields]) => {
      fields.forEach(field => {
        const input = document.querySelector(`[data-pile-field="${field}"]`);
        if (input) input.setAttribute('aria-invalid', buckets[section].length ? 'true' : 'false');
      });
    });
  }

  _activatePileCageField(sectionId, fieldKey, zoneIndex = null, zoneField = '') {
    if (!this.current?.roundPileCage) return;
    this._activePileSection = ['general', 'bars', 'spiral', 'hoops'].includes(sectionId) ? sectionId : 'general';
    this._syncPileActiveSection();
    const focusMap = {
      pileDiameter: 'pile-diameter', pileLength: 'pile-length',
      longitudinalDiameter: 'pile-longitudinal-diameter', straightBarCount: 'pile-longitudinal-bars', bentBarCount: 'pile-l-bars',
      straightBarLength: 'pile-longitudinal-bars', bentBarLength: 'pile-l-bars', bendLength: 'pile-l-hook', bendOrientationDeg: 'pile-l-hook',
      barSpacingDisplayMode: 'pile-bar-spacing',
      spiralDiameter: 'pile-spiral-diameter', spiralOuterDiameter: 'pile-spiral-diameter',
      hoopDiameter: 'pile-hoop-diameter', hoopOuterDiameter: 'pile-hoop-diameter', hoopQuantity: 'pile-hoops', hoopStart: 'pile-hoops', hoopSpacing: 'pile-hoop-spacing',
      length: 'pile-zone', pitch: 'pile-spiral-pitch', noWrap: 'pile-no-wrap', name: 'pile-zone',
    };
    this._focusFamilyField(focusMap[zoneField || fieldKey] || fieldKey || sectionId);
    const selector = zoneIndex === null
      ? `[data-pile-field="${fieldKey}"]`
      : `[data-zone-index="${Number(zoneIndex)}"] [data-zone-field="${zoneField || fieldKey || 'length'}"]`;
    requestAnimationFrame(() => {
      const input = document.querySelector(selector);
      input?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      input?.focus?.({ preventScroll: true });
      if (input?.select && input.type !== 'checkbox') input.select();
    });
  }

  _bindPileSvgClicks(svg) {
    if (!svg) return;
    svg.onclick = event => {
      const hit = event.target?.closest?.('[data-pile-edit]');
      if (!hit) return;
      const [sectionId, fieldKey, zoneIndex, zoneField] = String(hit.dataset.pileEdit || '').split('|');
      this._activatePileCageField(sectionId, fieldKey, zoneIndex === undefined || zoneIndex === '' ? null : Number(zoneIndex), zoneField || '');
    };
  }

  _refreshRoundPileEditorProjection() {
    if (!this.current?.roundPileCage) return;
    const pile = this.current;
    const zones = Array.isArray(pile.spiralZones) ? pile.spiralZones : [];
    const zoneQuick = zones.map((zone, index) => {
      const name = String(zone?.name || String.fromCharCode(65 + index));
      return zone?.noWrap
        ? `${name}: ${Number(zone.length || 0)} ס״מ ללא`
        : `${name}: ${Number(zone.length || 0)} ס״מ @ ${Number(zone.pitch || 0)} ס״מ`;
    }).join(' · ');
    const straightCount = Number(pile.straightBarCount || 0);
    const bentCount = Number(pile.bentBarCount || 0);
    const quick = {
      general: [`Ø${Number(pile.pileDiameter || 0)} · L ${Number(pile.pileLength || 0)}`, 'ס״מ'],
      bars: [`${straightCount} ישר + ${bentCount} L · Ø${Number(pile.longitudinalDiameter || 0)} מ״מ`, `כיפוף ${Number(pile.bendLength || 0)} ס״מ`],
      spiral: [`Ø${Number(pile.spiralDiameter || 0)} מ״מ · D${Number(pile.spiralOuterDiameter || 0)} ס״מ`, zoneQuick],
      hoops: [`${Number(pile.hoopQuantity || 0)} × Ø${Number(pile.hoopDiameter || 0)} מ״מ`, `D${Number(pile.hoopOuterDiameter || 0)} ס״מ · התחלה ${Number(pile.hoopStart || 0)} ס״מ · @${Number(pile.hoopSpacing || 0)} ס״מ`],
    };
    Object.entries(quick).forEach(([key, [value, detail]]) => {
      const card = document.querySelector(`[data-pile-quick="${key}"]`);
      const valueOut = card?.querySelector('[data-pile-quick-value]');
      const detailOut = card?.querySelector('[data-pile-quick-detail]');
      if (valueOut) valueOut.textContent = value;
      if (detailOut) detailOut.textContent = detail;
    });
    const sectionSummary = {
      general: `${quick.general[0]} ס״מ`,
      bars: quick.bars[0],
      spiral: `Ø${Number(pile.spiralDiameter || 0)} מ״מ · ${zoneQuick}`,
      hoops: `${Number(pile.hoopQuantity || 0)} × Ø${Number(pile.hoopDiameter || 0)} מ״מ · D${Number(pile.hoopOuterDiameter || 0)} ס״מ`,
    };
    Object.entries(sectionSummary).forEach(([key, value]) => {
      const output = document.querySelector(`[data-pile-section-summary="${key}"]`);
      if (output) output.textContent = value;
    });
    if (this._pileCageTemplateMode === ROUND_PILE_CAGE_STANDARD_TEMPLATE) {
      zones.forEach((zone, index) => {
        const row = document.querySelector(`[data-zone-index="${index}"]`);
        const nameInput = row?.querySelector('[data-zone-field="name"]');
        const lengthInput = row?.querySelector('[data-zone-field="length"]');
        const pitchInput = row?.querySelector('[data-zone-field="pitch"]');
        const noWrapInput = row?.querySelector('[data-zone-field="noWrap"]');
        if (nameInput && document.activeElement !== nameInput) nameInput.value = zone.name || '';
        if (lengthInput && document.activeElement !== lengthInput) lengthInput.value = zone.length ?? 0;
        if (pitchInput && document.activeElement !== pitchInput) pitchInput.value = zone.noWrap ? '' : (zone.pitch ?? '');
        if (pitchInput) pitchInput.disabled = zone.noWrap === true;
        if (noWrapInput) noWrapInput.checked = zone.noWrap === true;
      });
    }
    this._refreshRoundPileValidation();
  }

  _setPileField(key, val) {
    if (!this.current || this.current.family !== 'piles') return;
    const keepStandardSpiralTemplate = key === 'pileLength'
      && this.current.roundPileCage
      && (this._pileCageTemplateMode === ROUND_PILE_CAGE_STANDARD_TEMPLATE || matchesRoundPileCageStandardZones(this.current));
    if (key === 'bendOrientationDeg') {
      const parsed = normalizePileBendOrientationDeg(val, this.current.bendOrientationDeg ?? 0);
      const input = document.querySelector('[data-pile-field="bendOrientationDeg"]');
      if (parsed === null) {
        if (input) input.setAttribute('aria-invalid', 'true');
        return;
      }
      if (input) input.removeAttribute('aria-invalid');
      this.current.bendOrientationDeg = parsed;
      savePileBendOrientationDefault(parsed);
      this._refreshPileElementsSummary();
    } else if (key === 'hoopsEnabled') {
      this.current[key] = val === true || val === 1 || val === 'true' || val === 'on';
      this._refreshPileDerived();
      this._refreshPileElementsSummary();
    } else if (key === 'barPattern' || key === 'barSpacingDisplayMode' || key === 'spiralType' || key === 'hoopStartSide' || key === 'hoopShape') {
      this.current[key] = String(val || '');
      this._renderPileCageEditor();
    } else {
      const numeric = Number(val);
      const valid = Number.isFinite(numeric) && (pileFieldAllowsZero(key) ? numeric >= 0 : numeric > 0);
      const input = document.querySelector(`[data-pile-field="${key}"]`);
      if (!valid) {
        const labels = {
          pileDiameter: 'יש להזין קוטר כלוב', pileLength: 'יש להזין אורך כלוב',
          straightBarCount: 'יש להזין כמות מוטות ישרים', bentBarCount: 'יש להזין כמות מוטות מכופפים',
          spiralDiameter: 'יש להזין קוטר ברזל לספירלה', spiralOuterDiameter: 'יש להזין קוטר גיאומטרי לספירלה',
          hoopQuantity: 'יש להזין כמות טבעות', hoopDiameter: 'יש להזין קוטר ברזל לטבעות',
        };
        this._showPileInputError(labels[key] || 'יש להזין ערך גדול מאפס', input);
        return;
      }
      this._showPileInputError('', input);
      const parsed = key === 'longitudinalBars' || key.endsWith('Count') || key === 'hoopQuantity' ? Math.round(numeric) : numeric;
      this.current[key] = parsed;
      // Quick Entry exposes one authored cage-body length and one bend length.
      // Preserve the existing canonical bentBarLength contract by projecting
      // those two inputs into its developed length instead of asking the
      // operator to enter the same geometry twice.
      if (this.current.roundPileCage && (key === 'straightBarLength' || key === 'bendLength')) {
        this.current.bentBarLength = Number(this.current.straightBarLength || 0) + Number(this.current.bendLength || 0);
      }
      if (keepStandardSpiralTemplate) {
        this.current.spiralZones = buildRoundPileCageStandardZones(this.current.pileLength);
        this._pileCageTemplateMode = ROUND_PILE_CAGE_STANDARD_TEMPLATE;
      }
      if (key === 'longitudinalBars') this.current.longitudinalBarOverrides = normalizePileBarOverrides(this.current.longitudinalBarOverrides || [], this.current.longitudinalBars);
      this._refreshPileDerived();
      this._refreshPileElementsSummary();
    }
    this._refreshRoundPileEditorProjection();
    this._updatePreview();
  }

  _setSpiralZoneField(index, key, val) {
    if (!this.current || this.current.family !== 'piles' || !Array.isArray(this.current.spiralZones)) return;
    const zone = this.current.spiralZones[index];
    if (!zone) return;
    if (key === 'name') zone[key] = String(val);
    else if (key === 'noWrap') zone[key] = val === true || val === 1 || val === 'true' || val === 'on';
    else {
      const numeric = Number(val);
      const input = document.querySelector(`[data-zone-index="${Number(index)}"] [data-zone-field="${key}"]`);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        const zoneName = String(zone.name || String.fromCharCode(65 + index));
        this._showPileInputError(key === 'pitch' ? `חסרה פסיעה במקטע ${zoneName}` : `חסר אורך במקטע ${zoneName}`, input);
        return;
      }
      this._showPileInputError('', input);
      zone[key] = numeric;
    }
    this._pileCageTemplateMode = 'custom';
    const templateSelect = document.querySelector('[data-pile-template]');
    if (templateSelect) templateSelect.value = 'custom';
    this._refreshPileElementsSummary();
    this._refreshPileDerived();
    if (key === 'noWrap') {
      const pitchInput = document.querySelector(`[data-zone-index="${Number(index)}"] [data-zone-field="pitch"]`);
      if (pitchInput) {
        pitchInput.disabled = zone.noWrap === true;
        pitchInput.value = zone.noWrap ? '' : (zone.pitch ?? this.current.spiralPitch ?? 20);
      }
    }
    this._refreshRoundPileEditorProjection();
    this._updatePreview();
  }

  _addSpiralZone() {
    if (!this.current || this.current.family !== 'piles') return;
    if (!Array.isArray(this.current.spiralZones)) this.current.spiralZones = [];
    const name = 'Zone ' + String.fromCharCode(65 + this.current.spiralZones.length);
    this.current.spiralZones.push({ name, length: 100, pitch: 20 });
    this._pileCageTemplateMode = 'custom';
    this._renderPileCageEditor();
    this._updatePreview();
  }

  _deleteSpiralZone(index) {
    if (!this.current || this.current.family !== 'piles' || !Array.isArray(this.current.spiralZones)) return;
    this.current.spiralZones.splice(index, 1);
    this._pileCageTemplateMode = 'custom';
    this._renderPileCageEditor();
    this._updatePreview();
  }

  _setReal3D(enabled) {
    if (!this.current) return;
    this.current.is3d = enabled ? 1 : 0;
    if (enabled) {
      this._init3DAnglesFrom2D();
      window.seSetView?.('3d');
    } else {
      this.current.azAngles = Array(this.current.sides.length).fill(0);
      this.current.elAngles = Array(this.current.sides.length).fill(0);
      window.seSetView?.('2d');
    }
    this._renderTable();
    this._updatePreview();
  }

  _setSide(i, val) {
    if (!this.current) return;
    // Input is centimeters; sides are stored in millimeters.
    const raw = String(val ?? '').trim();
    const lengthCm = Number(raw);
    const input = document.querySelector(`[data-side="${i}"]`);
    if (!raw || !Number.isFinite(lengthCm) || lengthCm <= 0) {
      input?.setAttribute('aria-invalid', 'true');
      return;
    }
    input?.removeAttribute('aria-invalid');
    this.current.sides[i] = Math.round(lengthCm * 10);
    this._updatePreview({ debounceMs: 160 });
  }

  _finalizeSideInput(input, i) {
    if (!this.current || !input) return;
    const value = Number(input.value);
    if (Number.isFinite(value) && value > 0) {
      input.removeAttribute('aria-invalid');
      return;
    }
    input.value = formatLengthCmFromMm(this.current.sides[i], { withUnit: false, fallback: '' });
    input.removeAttribute('aria-invalid');
  }

  _finalizeAngleInput(input, i, kind) {
    if (!this.current || !input) return;
    const value = Number(input.value);
    if (String(input.value ?? '').trim() && Number.isFinite(value)) return;
    const stored = kind === 'az'
      ? this.current.azAngles?.[i]
      : kind === 'el'
        ? this.current.elAngles?.[i]
        : this.current.angles?.[i];
    input.value = Number.isFinite(Number(stored)) ? String(stored) : '0';
  }

  _setElementName(val) {
    if (!this.current) return;
    this.current.structElement = String(val || '');
    this._pendingElementName = this.current.structElement;
    const primary = document.getElementById('seElementName');
    if (primary && primary !== document.activeElement) primary.value = this.current.structElement;
    document.querySelectorAll('[data-pile-element-name]').forEach(input => {
      if (input !== document.activeElement) input.value = this.current.structElement;
    });
  }

  // Focus the element-name field once the editor is open (falls back to the
  // first side). Tried through a couple of timers so it lands regardless of
  // render/paint timing.
  _focusFirstSideSoon() {
    const focus = () => {
      const target = (this._el && this._el.querySelector('#seElementName'))
        || (this._el && this._el.querySelector('#seTableBody .se-input[data-side]'));
      if (target && document.activeElement !== target) {
        target.focus();
        if (typeof target.select === 'function') { try { target.select(); } catch (_) {} }
      }
    };
    requestAnimationFrame(focus);
    setTimeout(focus, 40);
    setTimeout(focus, 160);
  }

  _sideInputs() {
    return this._el ? Array.from(this._el.querySelectorAll('#seTableBody .se-input[data-side]')) : [];
  }
  _focusSide(input) {
    if (input) { input.focus(); if (typeof input.select === 'function') input.select(); }
  }
  // The ordered list of fields the arrows walk through: name, each side, then
  // diameter and quantity. Arrows only move between fields — never change a value.
  _fieldChain() {
    const chain = [];
    const name = this._el && this._el.querySelector('#seElementName');
    if (name) chain.push(name);
    this._sideInputs().forEach(i => chain.push(i));
    const dia = document.getElementById('seDiameterSelect');
    if (dia && dia.offsetParent !== null) chain.push(dia);
    const qty = document.getElementById('seQuantityInput');
    if (qty && qty.offsetParent !== null) chain.push(qty);
    return chain;
  }

  // One keyboard rhythm to build a whole item: type the item name, Enter moves
  // to the first side; type a side length, Enter adds the next side; Shift+Enter
  // jumps to the diameter; Enter there moves to the quantity; Enter there
  // confirms. Up/Down (and Left/Right) move between fields without changing values.
  _handleShapeKbd(e) {
    if (!this.current) return;
    const t = e.target;
    const isName = t && t.id === 'seElementName';
    const isSide = t && t.hasAttribute && t.hasAttribute('data-side');
    const isAngle = t && t.hasAttribute && (t.hasAttribute('data-angle') || t.hasAttribute('data-az') || t.hasAttribute('data-el'));
    const isDia = t && t.id === 'seDiameterSelect';
    const isQty = t && t.id === 'seQuantityInput';
    if (!isName && !isSide && !isAngle && !isDia && !isQty) return;

    if (e.key === 'Enter' && e.shiftKey) {
      const dia = document.getElementById('seDiameterSelect');
      if (dia && dia.offsetParent !== null) { e.preventDefault(); dia.focus(); }
      return;
    }
    if (e.key === 'Enter') {
      if (isName) {
        e.preventDefault();
        this._focusSide(this._sideInputs()[0]);
        return;
      }
      if (isSide) {
        e.preventDefault();
        this._addSide();
        const inputs = this._sideInputs();
        this._focusSide(inputs[inputs.length - 1]);
        return;
      }
      if (isAngle) {
        e.preventDefault();
        const idx = Number(t.getAttribute('data-angle') ?? t.getAttribute('data-az') ?? t.getAttribute('data-el'));
        const next = this._el.querySelector(`#seTableBody .se-input[data-side="${idx + 1}"]`);
        if (next) { this._focusSide(next); }
        else { this._addSide(); const inputs = this._sideInputs(); this._focusSide(inputs[inputs.length - 1]); }
        return;
      }
      if (isDia) {
        const q = document.getElementById('seQuantityInput');
        if (q && q.offsetParent !== null) { e.preventDefault(); q.focus(); if (q.select) q.select(); }
        return;
      }
      if (isQty) { e.preventDefault(); this._confirm(); return; }
    }
    // Delete removes the focused side row (an accidental extra side).
    if (e.key === 'Delete' && isSide) {
      const inputs = this._sideInputs();
      if (inputs.length > 1) {
        e.preventDefault();
        const idx = Number(t.getAttribute('data-side'));
        this._deleteSide(idx);
        const after = this._sideInputs();
        this._focusSide(after[Math.min(idx, after.length - 1)]);
      }
      return;
    }
    // Arrows move between fields only (never change a number/select value).
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const chain = this._fieldChain();
      const i = chain.indexOf(t);
      if (i === -1) return;
      const target = e.key === 'ArrowDown' ? chain[i + 1] : chain[i - 1];
      if (target) { e.preventDefault(); target.focus(); if (typeof target.select === 'function') { try { target.select(); } catch (_) {} } }
    }
  }

  _setAngle(i, val) {
    if (!this.current) return;
    const rawValue = String(val ?? '').trim();
    const numeric = Number(rawValue);
    const input = document.querySelector(`[data-angle="${i}"]`);
    if (!rawValue || !Number.isFinite(numeric)) {
      input?.setAttribute('aria-invalid', 'true');
      return;
    }
    input?.removeAttribute('aria-invalid');
    const raw = Math.min(360, Math.max(-360, numeric));
    // Negative input is the same bend on the full turn: -30 is stored as 330.
    const a = ((raw % 360) + 360) % 360;
    this.current.angles[i] = a;
    // ── Sync to azAngles (so 3D view stays consistent) ─────────────────
    // azAngles[i+1] = 180 - angles[i] so a default 90-degree bend displays as +90.
    if (this.current.azAngles && i + 1 < this.current.azAngles.length) {
      this.current.azAngles[i + 1] = 180 - a;
    }
    this._updatePreview({ debounceMs: 160 });
  }

  _setAzAngle(i, val) {
    if (!this.current) return;
    if (i === 0) return; // first segment has no turn — always 0
    const rawValue = String(val ?? '').trim();
    const numeric = Number(rawValue);
    const input = document.querySelector(`[data-az="${i}"]`);
    if (!rawValue || !Number.isFinite(numeric)) {
      input?.setAttribute('aria-invalid', 'true');
      return;
    }
    input?.removeAttribute('aria-invalid');
    const az = Math.min(360, Math.max(-360, Math.round(numeric)));
    if (!this.current.azAngles) this.current.azAngles = Array(this.current.sides.length).fill(0);
    this.current.azAngles[i] = az;
    // ── Sync back to 2D angles (machine data) ──────────────────────────
    // Inverse of: azAngles[i] = 180 - angles[i-1]
    //             angles[i-1] = 180 - azAngles[i]
    // Clamp to valid 2D range [-360, 360]; angles outside this range mean
    // a purely-3D direction change with no classic 2D equivalent.
    const ang2d = 180 - az;
    if (i - 1 >= 0 && i - 1 < this.current.angles.length) {
      if (ang2d >= -360 && ang2d <= 360) {
        // Store on the full 0-360 turn (same convention as _setAngle): -30 ≡ 330.
        this.current.angles[i - 1] = ((ang2d % 360) + 360) % 360;
      }
      // If outside range (e.g. "שמאל" +90 → ang2d=270), keep existing 2D angle
      // but flag the shape as 3D so the machine operator knows to check.
    }
    // sync input field
    const inp = document.querySelector(`[data-az="${i}"]`);
    if (inp) inp.value = az;
    // update quick-select buttons (match by value)
    document.querySelectorAll(`[data-az-btn^="${i}_"]`).forEach(b => {
      const bVal = Number(b.dataset.azBtn.split('_')[1]);
      b.classList.toggle('active', bVal === az);
    });
    this._updatePreview({ debounceMs: 160 });
  }

  // Convert flat 2D bend angles → azAngles for 3D renderer.
  // In 2D: dir -= (180 - angles[i]) at each bend.
  // In 3D cumAz: azAngles[segment] = direction change ADDED before drawing that segment.
  // Result: azAngles[0]=0, azAngles[i] = 180 - angles[i-1]  for i≥1
  _init3DAnglesFrom2D(render = true) {
    const { sides, angles } = this.current;
    const n = sides.length;
    const az = [0];
    for (let i = 0; i < angles.length && az.length < n; i++) {
      az.push(180 - (angles[i] ?? 180));
    }
    while (az.length < n) az.push(0);
    this.current.azAngles = az;
    if (!this.current.elAngles) this.current.elAngles = Array(n).fill(0);
    if (render) this._renderTable(); // refresh angle buttons to show new azAngles
  }

  _setElAngle(i, val) {
    if (!this.current) return;
    const rawValue = String(val ?? '').trim();
    const numeric = Number(rawValue);
    const input = document.querySelector(`[data-el="${i}"]`);
    if (!rawValue || !Number.isFinite(numeric)) {
      input?.setAttribute('aria-invalid', 'true');
      return;
    }
    input?.removeAttribute('aria-invalid');
    const el = Math.min(90, Math.max(-90, Math.round(numeric)));
    if (!this.current.elAngles) this.current.elAngles = Array(this.current.sides.length).fill(0);

    // First time setting any Z tilt: auto-initialize azAngles from 2D bend angles
    // so the shape doesn't collapse into a straight line.
    if (el !== 0 && this.current.azAngles?.every(a => a === 0) && this.current.angles?.length > 0) {
      this._init3DAnglesFrom2D();
    }

    this.current.elAngles[i] = el;
    const inp = document.querySelector(`[data-el="${i}"]`);
    if (inp) inp.value = el;
    document.querySelectorAll(`[data-el-btn^="${i}_"]`).forEach(b => {
      const bVal = Number(b.dataset.elBtn.split('_')[1]);
      b.classList.toggle('active', bVal === el);
    });
    this._updatePreview({ debounceMs: 160 });
  }

  _addSide() {
    if (!this.current) return;
    if (this.current.shapeType === 'straight_bar') this.current.shapeType = 'custom_bar';
    this.current.sides.push(300);
    if (this.current.sides.length > 1) this.current.angles.push(90);
    // 3D arrays — new segment defaults to a 90-degree bend, matching the 2D side editor.
    const n = this.current.sides.length - 1;
    if (!this.current.azAngles) this.current.azAngles = Array(n).fill(0);
    if (!this.current.elAngles) this.current.elAngles = Array(n).fill(0);
    this.current.azAngles.push(90);  // default bend angle for newly added side
    this.current.elAngles.push(0);
    this._renderTable();
    this._updatePreview();
  }

  _deleteSide(i) {
    if (!this.current || this.current.sides.length <= 1) return;
    this.current.sides.splice(i, 1);
    if (i < this.current.angles.length) this.current.angles.splice(i, 1);
    else if (this.current.angles.length > 0) this.current.angles.pop();
    // keep 3D arrays in sync
    if (this.current.azAngles) this.current.azAngles.splice(i, 1);
    if (this.current.elAngles) this.current.elAngles.splice(i, 1);
    this._renderTable();
    this._updatePreview();
  }

  _bindSvgClicks(svg) {
    svg.querySelectorAll('[data-seg-click]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._focusRow(parseInt(el.dataset.segClick), false);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const i = parseInt(el.dataset.segClick);
        this._editSideFromDrawing(i);
      });
    });
    svg.querySelectorAll('[data-ang-click]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._focusRow(parseInt(el.dataset.angClick), true);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const i = parseInt(el.dataset.angClick);
        this._editAngleFromDrawing(i);
      });
    });
  }

  _editSideFromDrawing(i) {
    if (!this.current || !Number.isInteger(i) || i < 0 || i >= this.current.sides.length) return;
    this._focusRow(i, false);
    // דאבל-קליק לעריכת אורך
    // ׳“׳׳‘׳-׳§׳׳™׳§ ׳׳¢׳¨׳™׳›׳× ׳׳•׳¨׳
    const next = prompt('דאבל-קליק לעריכת אורך', this.current.sides[i]);
    if (next == null) return;
    const val = Math.max(1, Math.min(20000, Number(next) || this.current.sides[i]));
    this.current.sides[i] = val;
    const inp = document.querySelector(`[data-side="${i}"]`);
    if (inp) inp.value = val;
    this._renderTable();
    this._updatePreview();
  }

  _editAngleFromDrawing(i) {
    if (!this.current || !Number.isInteger(i) || i < 0 || i >= this.current.angles.length) return;
    this._focusRow(i, true);
    // דאבל-קליק לעריכת זווית
    // ׳“׳׳‘׳-׳§׳׳™׳§ ׳׳¢׳¨׳™׳›׳× ׳–׳•׳•׳™׳×
    const next = prompt('דאבל-קליק לעריכת זווית', this.current.angles[i]);
    if (next == null) return;
    const val = Math.min(360, Math.max(-360, Number(next) || this.current.angles[i]));
    this.current.angles[i] = val;
    if (this.current.azAngles && i + 1 < this.current.azAngles.length) {
      this.current.azAngles[i + 1] = -(180 - val);
    }
    const inp = document.querySelector(`[data-angle="${i}"]`);
    if (inp) inp.value = val;
    this._renderTable();
    this._updatePreview();
  }

  _focusRow(i, focusAngle) {
    // Highlight segment in SVG
    this._activeSeg = i;
    this._updatePreview();

    const allRows = [...document.querySelectorAll('#seTableBody tr')];
    allRows.forEach(r => r.classList.remove('se-row-active'));
    const is3D = window._seViewMode !== '2d';
    let row;
    if (is3D) {
      row = allRows[i];
    } else {
      const segRows = allRows.filter(r => !r.classList.contains('se-bend-row'));
      row = segRows[i];
    }
    if (row) {
      row.classList.add('se-row-active');
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const sel = focusAngle === 'z' ? '[data-el]' : (focusAngle ? '[data-angle],[data-az]' : '[data-side]');
      const inp = row.querySelector(sel);
      if (inp) { setTimeout(() => { inp.focus(); inp.select(); }, 50); }
    }
  }

  // One rendering pass per animation frame keeps camera dragging and focus
  // changes smooth. Numeric typing can opt into a short debounce so a partial
  // value never redraws the product as a temporary broken shape.
  _updatePreview({ debounceMs = 0 } = {}) {
    const delay = Math.max(0, Number(debounceMs) || 0);
    if (this._previewDebounceTimer != null) {
      clearTimeout(this._previewDebounceTimer);
      this._previewDebounceTimer = null;
    }
    if (delay > 0) {
      if (this._previewFrame != null) {
        this._previewFrameCancel?.(this._previewFrame);
        this._previewFrame = null;
        this._previewFrameCancel = null;
      }
      this._previewDebounceTimer = setTimeout(() => {
        this._previewDebounceTimer = null;
        this._requestPreviewFrame();
      }, delay);
      return;
    }
    this._requestPreviewFrame();
  }

  _requestPreviewFrame() {
    if (this._previewFrame != null) return;
    const render = () => {
      this._previewFrame = null;
      this._previewFrameCancel = null;
      this._renderPreviewNow();
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      this._previewFrameCancel = window.cancelAnimationFrame?.bind(window) || null;
      this._previewFrame = window.requestAnimationFrame(render);
    } else {
      this._previewFrameCancel = clearTimeout;
      this._previewFrame = setTimeout(render, 0);
    }
  }

  _renderPreviewNow() {
    if (!this.current) return;
    const { sides, angles } = this.current;
    const svg = document.getElementById('seShapeSvg');
    if (!svg) return;
    this._refreshPileComponentGallery();
    svg.onclick = null;
    const is3D = window._seViewMode !== '2d';
    const isReal3D = this.current.is3d === 1 || this.current.is3d === true;
    const engine = ShapeEngineRouter(this.current);
    if (engine === PolylineBarEngine) svg.setAttribute('viewBox', '0 0 300 290');
    if (engine !== PolylineBarEngine) {
      const pileCageCanvas = Boolean(this.current.roundPileCage);
      const previewWidth = pileCageCanvas ? 520 : 300;
      svg.setAttribute('viewBox', pileCageCanvas ? '0 0 520 260' : '0 0 300 290');
      svg.innerHTML = ShapeEngineRouter.render(this.current, previewWidth, 260, { diameter: this._diameter || this.current.diameter || 12, view: is3D ? '3d' : '2d' });
      this._applyFamilyFocus(svg);
      if (this.current.roundPileCage) this._bindPileSvgClicks(svg);
      this._updateSummaryValues();
      return;
    }

    if (is3D) {
      const diam = this._diameter || 12;
      if (isReal3D && angles.length > 0 && (!this.current.azAngles || this.current.azAngles.every(a => Number(a || 0) === 0))) {
        this._init3DAnglesFrom2D(false);
      }
      const { azAngles, elAngles } = this.current;
      const has3D = isReal3D && (
        (azAngles && azAngles.some(a => a !== 0)) ||
        (elAngles && elAngles.some(a => a !== 0))
      );

      // Visual-only 3D must render the exact same flat bend geometry as 2D.
      // True 3D may use XYZ turn data only after the user explicitly marks it as real 3D.
      let effectiveAzAngles = azAngles;
      if (has3D && (!azAngles || azAngles.every(a => a === 0)) && angles.length > 0) {
        effectiveAzAngles = [0, ...angles.map(a => 180 - a)];
        while (effectiveAzAngles.length < sides.length) effectiveAzAngles.push(0);
      }

      svg.innerHTML = shape3DSVG(sides, angles, 300, 260, diam, {
        showAxes: true, showDims: true, showBends: false, compactLabels: true, dark: false,
        rotateDegrees: this._previewRotation || 0,
        camTheta:  this._camTheta,
        camPhi:    this._camPhi,
        azAngles:  has3D ? (effectiveAzAngles || Array(sides.length).fill(0)) : null,
        elAngles:  has3D ? (elAngles || []) : [],
        activeSeg: this._activeSeg ?? -1,
      });
      this._bindSvgClicks(svg);
    } else {
      const _activeSeg2d = this._activeSeg ?? -1;
      const isBenchProjection = isBenchBarShape(this.current) && sides.length === 5;
      const isRoundedProjection = isRoundedEndBarShape(this.current) && sides.length === 3;
      if (isRoundedProjection) {
        svg.innerHTML = roundedEndBarEditorSVG(sides, 300, 260, { radiusMm: this.current.radiusMm });
        this._applyFamilyFocus(svg);
        this._bindSvgClicks(svg);
        this._updateSummaryValues();
        return;
      }
      const stirrupParts = detectClosedStirrupParts(sides, angles);
      if (stirrupParts && !isBenchProjection) {
        svg.innerHTML = renderClosedStirrupEditor2D(stirrupParts, sides, 300, 260, {
          padding: 38,
          activeSeg: _activeSeg2d,
          rotateDegrees: this._previewRotation || 0,
        });
        this._applyFamilyFocus(svg);
        this._bindSvgClicks(svg);
        this._updateSummaryValues();
        return;
      }
      const { path, pts } = isBenchProjection
        ? benchBarSVGPath(sides, 300, 260, 38, { rotateDegrees: this._previewRotation || 0 })
        : shapeSVGPath(sides, angles, 300, 260, 38, { rotateDegrees: this._previewRotation || 0 });
      const BAR_PX = Math.max(4, Math.min((this._diameter||12)*0.55, 14));
      const SEG_GRAY = '#3d5e78'; // dark steel-blue — visible on the light editor background

      // Detect overlapping segments in 2D — same logic as 3D view for consistency.
      const offsets2d = computeSegOffsets(pts, BAR_PX);
      const hasOvlp2d = offsets2d.some(o => o !== 0);

      // Compute per-vertex screen offset (weighted average of adjacent segment offsets)
      const ptOff2d = pts.map((_, i) => {
        let sum = 0, cnt = 0;
        if (i > 0 && offsets2d[i - 1] !== 0) { sum += offsets2d[i - 1]; cnt++; }
        if (i < offsets2d.length && offsets2d[i] !== 0) { sum += offsets2d[i]; cnt++; }
        if (cnt === 0) return [0, 0];
        const off = sum / cnt;
        return [OVLP_DX * off, OVLP_DY * off];
      });

      // Build offset segments (used for body rendering, labels & arrows)
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1,y1] = pts[i], [x2,y2] = pts[i+1];
        const dx = x2-x1, dy = y2-y1, len = Math.sqrt(dx*dx+dy*dy)||1;
        const nx = -dy/len, ny = dx/len;
        const [ox1,oy1] = ptOff2d[i];
        const [ox2,oy2] = ptOff2d[i + 1];
        segs.push({
          x1: x1 + ox1, y1: y1 + oy1,
          x2: x2 + ox2, y2: y2 + oy2,
          nx, ny
        });
      }

      // Arrow marker helper
      const arrowHead = (x1,y1,x2,y2,color,size=7) => {
        const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1;
        const ux=dx/len,uy=dy/len,px=-uy,py=ux;
        const tip=[x2,y2];
        const b1=[x2-ux*size+px*size*0.45, y2-uy*size+py*size*0.45];
        const b2=[x2-ux*size-px*size*0.45, y2-uy*size-py*size*0.45];
        return `<polygon points="${tip[0].toFixed(1)},${tip[1].toFixed(1)} ${b1[0].toFixed(1)},${b1[1].toFixed(1)} ${b2[0].toFixed(1)},${b2[1].toFixed(1)}" fill="${color}" opacity="0.85"/>`;
      };

      let html = '';

      // ── Bar body — always drawn from segs (which incorporate any overlap offset) ──
      {
        // Draw each visible side exactly once. Active side is a color replacement,
        // not an overlay, so it cannot look thicker than the bar.
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          const isActive = i === _activeSeg2d;
          html += `<path d="M ${s.x1.toFixed(1)},${s.y1.toFixed(1)} L ${s.x2.toFixed(1)},${s.y2.toFixed(1)}"
            stroke="${SEG_GRAY}" stroke-width="4" fill="none" stroke-linecap="round"
            stroke-linejoin="round" data-se-focus="bar-all bar-side-${i}"
            data-seg-click="${i}" style="cursor:pointer"/>`;
        }
      }

      // Start dot
      if (segs.length > 0)
        html += `<circle cx="${segs[0].x1.toFixed(1)}" cy="${segs[0].y1.toFixed(1)}" r="4"
          fill="#526070" stroke="white" stroke-width="1.5"/>`;

      // Invisible wide click areas (one per segment, sits over the polyline)
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        html += `<path d="M ${s.x1.toFixed(1)},${s.y1.toFixed(1)} L ${s.x2.toFixed(1)},${s.y2.toFixed(1)}"
          stroke="transparent" stroke-width="14" fill="none" data-se-focus="bar-side-${i}"
          data-seg-click="${i}" style="cursor:pointer"/>`;
      }

      // Dimension tags: small white windows aligned with each side.
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const isAct = i === _activeSeg2d;
        const stroke = isAct ? '#ff4047' : '#9aa3b2';
        const fill = isAct ? '#fff4f4' : '#ffffff';
        const mx=(s.x1+s.x2)/2, my=(s.y1+s.y2)/2;
        const lx=mx+s.nx*24, ly=my+s.ny*24;
        const rawAngle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180 / Math.PI;
        const labelAngle = normalizeReadableLabelAngle(rawAngle);
        const value = formatLengthCmFromMm(sides[i]);
        const tagW = dimensionTagWidth(value);
        html += `<g data-se-focus="bar-side-${i}" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(${labelAngle.toFixed(1)})"
            data-seg-click="${i}" style="cursor:pointer">
          <rect x="${(-tagW/2).toFixed(1)}" y="-8" width="${tagW}" height="16" rx="3"
            fill="${fill}" stroke="${stroke}" stroke-width=".8"
            data-seg-click="${i}"/>
          <text x="0" y="4" text-anchor="middle" font-size="10"
            font-family="Heebo,Arial" font-weight="800" fill="#111827"
            data-seg-click="${i}">${value}</text>
        </g>`;
      }

      // Bend marks: right angle gets a clean corner marker without number.
      if (segs.length > 1) {
        for (let i = 0; i < segs.length - 1; i++) {
          const bx = segs[i].x2, by = segs[i].y2;
          const angle = Number(angles[i]);
          if (angles[i] === undefined || angle === 180) continue;
          const s1 = segs[i], s2 = segs[i + 1];
          const len1 = Math.hypot(s1.x2 - s1.x1, s1.y2 - s1.y1) || 1;
          const len2 = Math.hypot(s2.x2 - s2.x1, s2.y2 - s2.y1) || 1;
          const u1x = (s1.x1 - bx) / len1, u1y = (s1.y1 - by) / len1;
          const u2x = (s2.x2 - bx) / len2, u2y = (s2.y2 - by) / len2;
          if (Math.abs(Math.abs(angle) - 90) < 0.001) {
            const m = 8;
            const p1x = bx + u1x * m, p1y = by + u1y * m;
            const p2x = p1x + u2x * m, p2y = p1y + u2y * m;
            const p3x = bx + u2x * m, p3y = by + u2y * m;
            html += `<path d="M ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)} L ${p3x.toFixed(1)} ${p3y.toFixed(1)}"
              fill="none" stroke="#c4c8cf" stroke-width="2" data-se-focus="bar-angle-${i}"
              data-ang-click="${i}" style="cursor:pointer"/>`;
          } else {
            let bxOut = u1x + u2x;
            let byOut = u1y + u2y;
            const bLen = Math.hypot(bxOut, byOut) || 1;
            bxOut /= bLen;
            byOut /= bLen;
            const r = Math.max(14, Math.min(24, Math.min(len1, len2) * 0.24));
            const ax1 = bx + u1x * r;
            const ay1 = by + u1y * r;
            const ax2 = bx + u2x * r;
            const ay2 = by + u2y * r;
            const labelDist = r + 13;
            const tx = bx + bxOut * labelDist;
            const ty = by + byOut * labelDist;
            const value = String(angle) + '\u00B0';
            const largeArc = Math.abs(angle) > 180 ? 1 : 0;
            const sweep = angle >= 0 ? 1 : 0;
            html += `<g data-se-focus="bar-angle-${i}" data-ang-click="${i}" style="cursor:pointer">
              <path d="M ${ax1.toFixed(1)} ${ay1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${largeArc} ${sweep} ${ax2.toFixed(1)} ${ay2.toFixed(1)}"
                fill="none" stroke="#c9621a" stroke-width="1.6" stroke-linecap="round"/>
              <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="9"
                font-family="Heebo,Arial" font-weight="900" fill="#c9621a">${value}</text>
            </g>`;
          }
        }
      }

      svg.innerHTML = html;
      this._applyFamilyFocus(svg);
      this._bindSvgClicks(svg);
    }

    this._updateSummaryValues();
  }

  _confirm() {
    if (!this.current || !this.onSelect) return;
    if (this.current.roundPileCage) {
      const pileResult = PileCageEngine.calculate(this.current);
      if (!pileResult.validation?.valid) {
        const firstError = String(pileResult.validation?.errors?.[0] || 'נתוני הכלוב אינם תקינים');
        const isHoopError = /hoop/i.test(firstError);
        const section = isHoopError ? 'hoops' : /spiral|pitch/i.test(firstError) ? 'spiral' : 'general';
        const field = isHoopError ? 'hoopQuantity' : section === 'spiral' ? 'spiralDiameter' : 'pileDiameter';
        this._activatePileCageField(section, field);
        const input = document.querySelector(`[data-pile-field="${field}"]`);
        this._showPileInputError(localizePileValidationError(firstError), input);
        const okBtn = document.getElementById('seOk');
        if (okBtn) { okBtn.classList.add('se-blocked'); setTimeout(() => okBtn.classList.remove('se-blocked'), 900); }
        input?.focus();
        return;
      }
    }
    // Bar shapes must have a diameter and a quantity. Block confirm and flag the
    // missing fields in red instead of saving an item with 0.
    if (this.current.family === 'bars') {
      const diaEl = document.getElementById('seDiameterSelect');
      const qtyEl = document.getElementById('seQuantityInput');
      const sideInputs = this._sideInputs();
      const diaOk = Number(this.current.diameter) >= 5.5;
      const qtyOk = Math.max(0, Number(this.current.quantity || this.current.qty || 0) || 0) >= 1;
      const sidesOk = Array.isArray(this.current.sides)
        && this.current.sides.length > 0
        && this.current.sides.every(side => Number(side) > 0);
      if (diaEl && diaEl.offsetParent !== null && (!diaOk || !qtyOk || !sidesOk)) {
        if (diaEl) diaEl.classList.toggle('se-invalid', !diaOk);
        if (qtyEl) qtyEl.classList.toggle('se-invalid', !qtyOk);
        sideInputs.forEach((input, index) => input.classList.toggle('se-invalid', Number(this.current.sides?.[index]) <= 0));
        const okBtn = document.getElementById('seOk');
        if (okBtn) { okBtn.classList.add('se-blocked'); setTimeout(() => okBtn.classList.remove('se-blocked'), 900); }
        const focusEl = !sidesOk ? sideInputs.find((input, index) => Number(this.current.sides?.[index]) <= 0) : !diaOk ? diaEl : qtyEl;
        if (focusEl) focusEl.focus();
        return;
      }
    }
    if (isStandaloneRingShape(this.current)) {
      const barEl = document.getElementById('seRingBarDiameter');
      const ringEl = document.getElementById('seRingDiameter');
      const overlapEl = document.getElementById('seRingOverlap');
      const qtyEl = document.getElementById('seQuantityInput');
      const barOk = Number(this.current.barDiameter) > 0;
      const ringOk = Number(this.current.ringDiameter || this.current.spiralDiameter) > 0;
      const overlapOk = Number(this.current.overlap || this.current.overlapMm || 0) >= 0;
      const qtyOk = Math.max(0, Number(this.current.quantity || this.current.qty || 0) || 0) >= 1;
      [
        [barEl, barOk], [ringEl, ringOk], [overlapEl, overlapOk], [qtyEl, qtyOk],
      ].forEach(([el, valid]) => el?.classList.toggle('se-invalid', !valid));
      if (!barOk || !ringOk || !overlapOk || !qtyOk) {
        const okBtn = document.getElementById('seOk');
        if (okBtn) { okBtn.classList.add('se-blocked'); setTimeout(() => okBtn.classList.remove('se-blocked'), 900); }
        const focusEl = !barOk ? barEl : !ringOk ? ringEl : !overlapOk ? overlapEl : qtyEl;
        focusEl?.focus();
        return;
      }
    }
    const isReal3D = this.current.is3d === 1 || this.current.is3d === true;
    const orderItemQuantity = Math.max(1, Number(this.current.quantity || this.current.qty || 1) || 1);
    const normalized = {
      ...this.current,
      is3d: isReal3D ? 1 : 0,
      azAngles: isReal3D ? (this.current.azAngles || []) : null,
      elAngles: isReal3D ? (this.current.elAngles || []) : null,
    };
    delete normalized.quantity;
    delete normalized.qty;
    const contract = buildShapeDataContractV2(normalized);
    this.onSelect({
      ...legacyApprovedShapeFields(normalized, contract),
      ...contract,
      orderItemQuantity,
      structElement: (document.getElementById('seElementName')?.value ?? this.current.structElement ?? '').trim(),
    });
    this.close();
  }

  open(existingData) {
    if (!this._el || !document.body.contains(this._el)) this._ensureDom();
    window._seEditor = this;
    this._openedAt = Date.now();
    this._backdropPress = false;
    this._hideSaveBar?.();
    this._el.classList.remove('show');
    // Seed the item-name field from the row (empty for a brand-new item).
    this._pendingElementName = String(existingData?.structElement || existingData?.elementName || '');
    const nameInput = this._el.querySelector('#seElementName');
    if (nameInput) nameInput.value = this._pendingElementName;
    // Show which item is being edited so the operator never loses their place.
    const itemNumEl = this._el.querySelector('#seItemNumber');
    if (itemNumEl) {
      const n = Number(existingData?.itemNumber || 0);
      const total = Number(existingData?.itemTotal || 0);
      itemNumEl.textContent = n > 0 ? ('פריט ' + n + (total > 0 ? '/' + total : '')) : '';
    }
    // Sync orbit controls and cursor to current view mode on open
    const orbitCtrl = document.getElementById('se3DOrbitCtrl');
    const svgWrap   = document.getElementById('seSvgWrap');
    const is3D = window._seViewMode !== '2d';
    if (orbitCtrl) orbitCtrl.style.display = is3D ? 'flex' : 'none';
    if (svgWrap)   svgWrap.classList.toggle('grab-mode', is3D);
    this._pendingQuantity = Math.max(0, Number(existingData?.quantity ?? existingData?.qty ?? 0) || 0);
    this._pendingDiameter = Math.max(0, Number(existingData?.diameter ?? existingData?.diameterMm ?? 0) || 0);
    this._blankNewEntry = !existingData?.presetId
      && !existingData?.shapeId
      && !(Array.isArray(existingData?.sides) && existingData.sides.length)
      && this._pendingQuantity === 0
      && this._pendingDiameter === 0;
    if (this._blankNewEntry) this.current = null;
    this._previewRotation = shapePreviewRotation(existingData || {});
    seSyncRotateButton();
    if (existingData?.family === 'mesh' || existingData?.family === 'piles' || existingData?.family === 'spirals') {
      this.current = { ...existingData, quantity: this._pendingQuantity };
      this._pileCageTemplateMode = existingData?.roundPileCage && matchesRoundPileCageStandardZones(existingData)
        ? ROUND_PILE_CAGE_STANDARD_TEMPLATE
        : 'custom';
      document.querySelectorAll('.se-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.id === existingData.presetId));
      this._goToEdit();
    } else if (existingData?.sides?.length) {
      const n = existingData.sides.length;
      // Derive azAngles from 2D bend angles when not saved with the shape.
      // Formula: azAngles[i] = 180 - angles[i-1]  (same as _init3DAnglesFrom2D)
      // This ensures the 3D table shows the correct turn for each segment,
      // matching the actual bend angles that go to the machine.
      let initAz;
      if (existingData.azAngles?.length === n) {
        initAz = [...existingData.azAngles];
      } else {
        initAz = [0, ...(existingData.angles || []).map(a => 180 - (a ?? 180))];
        while (initAz.length < n) initAz.push(0);
        initAz = initAz.slice(0, n);
      }
      this.current = {
        ...existingData,
        quantity: this._pendingQuantity,
        is3d: existingData.is3d ? 1 : 0,
        azAngles: initAz,
        elAngles: existingData.elAngles?.length === n
          ? [...existingData.elAngles]
          : Array(n).fill(0),
      };
      document.querySelectorAll('.se-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.id === existingData.presetId));
      this._goToEdit();
    } else {
      // No existing shape: open editor directly.
      this._selectedCount = null;
      this._selectedSideCount = null;
      this._startDefaultEdit('bars');
    }
    // Apply the requested quantity/name once (presets seed quantity=1, which
    // would otherwise hide that a new item still needs a quantity).
    if (this.current && (this.current.family === 'bars' || isStandaloneRingShape(this.current))) {
      this.current.quantity = this._pendingQuantity;
      this.current.structElement = this._pendingElementName || this.current.structElement || '';
      this._updateSummaryValues();
    }
    this._el.classList.add('show');
    document.body.classList.add('se-open');
    this._focusFirstSideSoon();
  }

  close() {
    if (window._seResetDrag) window._seResetDrag();
    this._hideSaveBar?.();
    this._el.classList.remove('show');
    document.body.classList.remove('se-open');
  }
}

// ── VIEW MODE TOGGLE (global, called from onclick) ────────────────
window._seViewMode = '2d'; // default to precise 2D editing; 3D is optional review
window.IronBendShapeGeometry = {
  calcShapePoints,
  calcShapePoints3D,
  shapeSVGPath,
  benchBarSVGPath,
  shape3DSVG,
  formatLengthCmFromMm,
  rotatePointListAroundBounds,
  rotate3DPointsForView,
  PolylineBarEngine,
  MeshEngine,
  PileCageEngine,
  RingEngine,
  ShapeEngineRouter,
  ShapeEditorModal,
  buildShapeDataContractV2,
  buildBarsShapeContract,
  buildSpiralShapeContract,
  buildRingShapeContract,
  isStandaloneRingShape,
  calculateRoundPileCage,
  validateShapeContractData,
};
window.seSyncRotateButton = function() {
  const btn = document.getElementById('seRotateShape');
  if (!btn) return;
  const rotation = ((Number(window._seEditor?._previewRotation || 0) % 360) + 360) % 360;
  const active = rotation !== 0;
  const base = 'padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:900;transition:all .15s;';
  btn.style.cssText = active
    ? base + 'border:1.5px solid #ff4047;background:#ff4047;color:#fff;'
    : base + 'border:1.5px solid #d8e2ec;background:#f4f6f9;color:#526070;';
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.textContent = rotation ? rotation + '°' : '90°';
};
window.seRotateShape90 = function() {
  if (!window._seEditor) return;
  window._seEditor._previewRotation = ((Number(window._seEditor._previewRotation || 0) + 90) % 360 + 360) % 360;
  window.seSyncRotateButton();
  window._seEditor._updatePreview();
};
window.seSetView = function(mode) {
  window._seViewMode = mode;
  // Cancel any active drag when switching modes
  if (window._seResetDrag) window._seResetDrag();
  const btn2d = document.getElementById('seView2D');
  const btn3d = document.getElementById('seView3D');
  if (btn2d && btn3d) {
    const base  = 'padding:5px 14px;border-radius:6px;font-family:Heebo,sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;';
    const active = base + 'border:1.5px solid #ff4047;background:#ff4047;color:#fff;box-shadow:none;';
    const idle   = base + 'border:1.5px solid #c5cbd4;background:#fff;color:#526070;box-shadow:none;';
    btn2d.style.cssText = (mode === '2d' ? active : idle);
    btn3d.style.cssText = (mode === '3d' ? active : idle);
    btn2d.textContent = '2D';
    btn3d.textContent = '3D';
  }
  // Show/hide orbit controls and grab cursor based on mode
  const orbitCtrl = document.getElementById('se3DOrbitCtrl');
  const svgWrap   = document.getElementById('seSvgWrap');
  if (orbitCtrl) orbitCtrl.style.display = (mode === '3d') ? 'flex' : 'none';
  if (svgWrap)   svgWrap.classList.toggle('grab-mode', mode === '3d');

  if (window._seEditor) {
    window._seEditor._renderTable();
    window._seEditor._updatePreview();
  }
};


