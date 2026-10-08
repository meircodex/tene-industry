const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { shapeSvg, itemShapeSvg } = require('../services/productionCards');
const steelRebarShapes = require('../modules/steel-rebar/shapes');
const { normalizeFactorySegments, normalizeFactoryShapeName, spiralCutLengthMm } = steelRebarShapes;
const { distributeSurplusToEndSegments } = require('../services/intakeWorkflow');

function loadShapeEditorGeometry(initialStorage = {}) {
  const snapshotSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'shapeSnapshot.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const context = {
    window: {},
    IronBendSteelRebarShapes: steelRebarShapes,
    console,
    localStorage: {
      _values: { ...initialStorage },
      getItem(key) { return Object.prototype.hasOwnProperty.call(this._values, key) ? this._values[key] : null; },
      setItem(key, value) { this._values[key] = String(value); },
      removeItem(key) { delete this._values[key]; },
    },
  };
  context.window.IronBendSteelRebarShapes = steelRebarShapes;
  vm.createContext(context);
  vm.runInContext(snapshotSource, context);
  vm.runInContext(source, context);
  return context;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

test('shape geometry closes a square when all four bends are 90 degrees', () => {
  const { calcShapePoints } = loadShapeEditorGeometry();
  const points = calcShapePoints([150, 150, 150, 150], [90, 90, 90, 90]);
  const first = points[0];
  const last = points[points.length - 1];

  assert.ok(distance(first, last) < 0.000001, `expected square to close, got ${JSON.stringify(points)}`);
  const rounded = points.map(p => p.map(n => Object.is(Math.round(n), -0) ? 0 : Math.round(n)));
  assert.equal(JSON.stringify(rounded), JSON.stringify([
    [0, 0],
    [150, 0],
    [150, -150],
    [0, -150],
    [0, 0],
  ]));
});

test('shape editor 2D preview rotates U bars so the long bridge is the bottom base', () => {
  const { shapeSVGPath } = loadShapeEditorGeometry();
  const { pts } = shapeSVGPath([300, 1000, 300], [90, 90], 300, 260, 38);
  const segments = pts.slice(0, -1).map((point, index) => {
    const next = pts[index + 1];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    return { dx, dy, length: Math.hypot(dx, dy), y: (point[1] + next[1]) / 2 };
  });
  const longest = segments.reduce((best, segment) => segment.length > best.length ? segment : best, segments[0]);
  const centerY = pts.reduce((sum, point) => sum + point[1], 0) / pts.length;

  assert.ok(Math.abs(longest.dy) < 0.2, 'expected the long bridge side to be horizontal');
  assert.ok(centerY <= longest.y, 'expected the long bridge to be the bottom base with the legs/body above it');
});

test('shape editor exposes a visual-only 90-degree rotation control for ambiguous bar orientation', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const { shapeSVGPath } = loadShapeEditorGeometry();
  const { pts } = shapeSVGPath([300, 1000, 300], [90, 90], 300, 260, 38, { rotateDegrees: 90 });
  const segments = pts.slice(0, -1).map((point, index) => {
    const next = pts[index + 1];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    return { dx, dy, length: Math.hypot(dx, dy) };
  });
  const longest = segments.reduce((best, segment) => segment.length > best.length ? segment : best, segments[0]);

  assert.match(editor, /id="seRotateShape"/);
  assert.match(editor, /window.seRotateShape90 = function/);
  assert.match(editor, /_previewRotation/);
  assert.ok(Math.abs(longest.dx) < 0.2, 'expected 90-degree rotation to turn the long side vertical');
  assert.ok(Math.abs(longest.dy) > 100, 'expected rotated preview to keep the full shape geometry, not just move labels');
});

test('shape previews display one centimetre unit contract without changing millimetre geometry', () => {
  const { ShapeEngineRouter, formatLengthCmFromMm } = loadShapeEditorGeometry().window.IronBendShapeGeometry;
  const svg = ShapeEngineRouter.render({ family: 'bars', sides: [1010, 300], angles: [90] }, 300, 260);

  assert.equal(formatLengthCmFromMm(1010), '101 ס״מ');
  assert.equal(formatLengthCmFromMm(305), '30.5 ס״מ');
  assert.match(svg, />101 ס״מ</);
  assert.match(svg, />30 ס״מ</);
  assert.doesNotMatch(svg, />1010</);
});

test('visual rotations preserve the shape coordinates and never mutate the 3D product model', () => {
  const { rotatePointListAroundBounds, rotate3DPointsForView } = loadShapeEditorGeometry().window.IronBendShapeGeometry;
  const twoD = [[0, 0], [1000, 0], [1000, 250]];
  const threeD = [[0, 0, 0], [1000, 0, 0], [1000, 250, 300]];
  const rotated2D = rotatePointListAroundBounds(twoD, 37);
  const rotated3D = rotate3DPointsForView(threeD, 37);

  assert.deepEqual(twoD, [[0, 0], [1000, 0], [1000, 250]]);
  assert.deepEqual(threeD, [[0, 0, 0], [1000, 0, 0], [1000, 250, 300]]);
  assert.ok(Math.abs(distance(rotated2D[0], rotated2D[1]) - 1000) < 0.000001);
  assert.ok(Math.abs(distance(rotated3D[0], rotated3D[1]) - 1000) < 0.000001);
  assert.equal(rotated3D[2][2], 300);
});

test('bench preset opens as real 3D and keeps the schedule elevation in every 2D view', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const { buildShapeDataContractV2, calcShapePoints3D, benchBarSVGPath } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'bars',
    shapeType: 'bench_bar',
    presetId: 's15',
    presetName: 'ספסל',
    sides: [280, 170, 300, 170, 280],
    angles: [90, 90, 90, 90],
    is3d: 1,
    azAngles: [0, 90, 90, 90, 90],
    elAngles: [90, 0, 0, 0, 90],
    diameter: 12,
  });
  const points = calcShapePoints3D(
    [280, 170, 300, 170, 280],
    [0, 90, 90, 90, 90],
    [90, 0, 0, 0, 90],
  );
  const elevation = benchBarSVGPath([280, 170, 300, 170, 280], 300, 260, 38).pts;

  assert.match(editor, /id: 's15'.*name: 'ספסל'.*sides: \[280, 170, 300, 170, 280\].*is3d: 1.*azAngles: \[0, 90, 90, 90, 90\].*elAngles: \[90, 0, 0, 0, 90\].*shapeType: 'bench_bar'/);
  assert.match(editor, /data-edit-family="bench"[^>]*>[^\n]*<span>ספסל<\/span>/);
  assert.match(editor, /bench: `<path \$\{stroke\} d="M10 38 L31 64 V28 H69 V62 L89 78"\/>`/);
  const acuteVertex = [31, 64];
  const incomingRay = [10 - acuteVertex[0], 38 - acuteVertex[1]];
  const outgoingRay = [31 - acuteVertex[0], 28 - acuteVertex[1]];
  const interiorDotProduct = incomingRay[0] * outgoingRay[0] + incomingRay[1] * outgoingRay[1];
  assert.ok(interiorDotProduct > 0, 'expected the left bench icon corner to be acute, not obtuse');
  assert.match(editor, /family === 'bench'.*SHAPE_PRESETS\.find\(isBenchBarShape\)/);
  assert.match(editor, /if \(isReal3D\) window\.seSetView\?\.\('3d'\)/);
  assert.match(editor, /diameter:\s+isBlankNewEntry \? 0 : \(Number\(preset\.diameter \?\? this\.current\?\.diameter \?\? this\._pendingDiameter/);
  assert.equal(contract.shapeType, 'bench_bar');
  assert.deepEqual(Array.from(contract.data.sides), [280, 170, 300, 170, 280]);
  assert.deepEqual(Array.from(contract.data.angles), [90, 90, 90, 90]);
  assert.equal(contract.data.is3d, 1);
  assert.deepEqual(Array.from(contract.data.azAngles), [0, 90, 90, 90, 90]);
  assert.deepEqual(Array.from(contract.data.elAngles), [90, 0, 0, 0, 90]);
  assert.equal(contract.calculated.unitLengthMm, 1200);
  assert.equal(points.length, 6);
  assert.ok(Math.abs(points[1][2] - points[0][2] - 280) < 0.001, 'expected the first 28 cm side on the Z axis');
  assert.ok(points.slice(1, 5).every(point => Math.abs(point[2] - 280) < 0.001), 'expected the 17-30-17 cm bridge in one plane');
  assert.ok(Math.abs(points[5][2] - points[4][2] - 280) < 0.001, 'expected the final 28 cm side on the Z axis');
  assert.ok(Math.abs(elevation[1][0] - elevation[2][0]) < 0.001, 'expected the left 17 cm rise to be vertical in 2D');
  assert.ok(Math.abs(elevation[2][1] - elevation[3][1]) < 0.001, 'expected the 30 cm bridge to be horizontal in 2D');
  assert.ok(Math.abs(elevation[3][0] - elevation[4][0]) < 0.001, 'expected the right 17 cm drop to be vertical in 2D');
  assert.ok(elevation[0][0] < elevation[1][0] && elevation[0][1] < elevation[1][1], 'expected the left 28 cm foot to enter the rise through an acute corner');
  const elevationIncoming = [elevation[0][0] - elevation[1][0], elevation[0][1] - elevation[1][1]];
  const elevationOutgoing = [elevation[2][0] - elevation[1][0], elevation[2][1] - elevation[1][1]];
  assert.ok(elevationIncoming[0] * elevationOutgoing[0] + elevationIncoming[1] * elevationOutgoing[1] > 0, 'expected the full 2D bench projection to keep the acute left corner');
  assert.ok(elevation[5][0] > elevation[4][0] && elevation[5][1] > elevation[4][1], 'expected the right 28 cm foot to angle outward');
  assert.match(editor, /isBenchProjection\s*\?\s*benchBarSVGPath\(sides, 300, 260, 38, \{ rotateDegrees: this\._previewRotation \|\| 0 \}\)/);
});

test('production card keeps all five bench segments and the 120 cm cut length', () => {
  const svg = itemShapeSvg({
    shape_name: 'ספסל',
    segments: JSON.stringify([
      { length_mm: 280, angle_deg: 90 },
      { length_mm: 170, angle_deg: 90 },
      { length_mm: 300, angle_deg: 90 },
      { length_mm: 170, angle_deg: 90 },
      { length_mm: 280, angle_deg: null },
    ]),
    shape_snapshot_json: JSON.stringify({
      family: 'bars',
      shapeType: 'bench_bar',
      displayName: 'ספסל',
      data: { sides: [280, 170, 300, 170, 280], angles: [90, 90, 90, 90], diameter: 12 },
    }),
  });
  const pathMatch = svg.match(/<path d="M ([^"]+)"/);
  assert.match(svg, /data-shape-kind="bench-bar"/);
  assert.match(svg, /data-dimension="2d"/);
  assert.match(svg, /data-scale-mode="container-fit"/);
  assert.doesNotMatch(svg, /max-height:/);
  assert.ok(pathMatch, 'expected a bench SVG path');
  const points = pathMatch[1].split(' L ').map(pair => pair.split(',').map(Number));
  assert.equal(points.length, 6);
  assert.ok(points[0][0] < points[1][0] && points[0][1] < points[1][1]);
  const incoming = [points[0][0] - points[1][0], points[0][1] - points[1][1]];
  const outgoing = [points[2][0] - points[1][0], points[2][1] - points[1][1]];
  assert.ok(incoming[0] * outgoing[0] + incoming[1] * outgoing[1] > 0, 'expected the production bench SVG to keep the acute left corner');
  assert.equal(points[1][0], points[2][0]);
  assert.equal(points[2][1], points[3][1]);
  assert.equal(points[3][0], points[4][0]);
  assert.ok(points[5][0] > points[4][0] && points[5][1] > points[4][1]);
  assert.equal([280, 170, 300, 170, 280].reduce((sum, side) => sum + side, 0), 1200);
});

test('rounded-end bar keeps optional bend radius in the contract and production drawing', () => {
  const contract = steelRebarShapes.buildBarsShapeContract({
    shapeType: 'rounded_end_bar',
    roundedBends: true,
    radiusMm: 35,
    diameter: 8,
    sides: [80, 240, 80],
    angles: [90, 90],
  }, { quantity: 112 });

  assert.equal(contract.data.roundedBends, true);
  assert.equal(contract.data.radiusMm, 35);
  assert.equal(contract.generic.shapeType, 'rounded_end_bar');
  assert.equal(contract.generic.segments[0].bendRadiusMm, 35);
  assert.equal(contract.component.unitLengthMm, 400);

  const svg = itemShapeSvg({
    segments: JSON.stringify([
      { length_mm: 80, angle_deg: 90 },
      { length_mm: 240, angle_deg: 90 },
      { length_mm: 80, angle_deg: null },
    ]),
    shape_snapshot_json: JSON.stringify({
      family: 'bars',
      shapeType: 'rounded_end_bar',
      data: { sides: [80, 240, 80], angles: [90, 90], diameter: 8, roundedBends: true, radiusMm: 35 },
    }),
  });

  assert.match(svg, /data-shape-kind="rounded-end-bar"/);
  assert.match(svg, /data-bend-radius-mm="35"/);
  assert.match(svg, / Q /, 'expected visibly curved bends');
  assert.match(svg, />R 3\.5</);
});

test('shape editor exposes the rounded-end preset and optional radius field', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  assert.match(editor, /id: 's16'.*shapeType: 'rounded_end_bar'.*roundedBends: true/);
  assert.match(editor, /id="seRadiusInput"/);
  assert.match(editor, /roundedEndBarEditorSVG\(sides, 300, 260/);
});

test('visual-only 3D preview does not use true-3D azimuth arrays', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /const isReal3D = this\.current\.is3d === 1 \|\| this\.current\.is3d === true/);
  assert.match(editor, /const has3D = isReal3D && \(/);
  assert.match(editor, /azAngles:\s+has3D \?/);
});

test('shape editor supports bend angles from -360 to 360 without quick angle buttons in 2D rows', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /data-angle="\$\{i\}"/);
  assert.match(editor, /min="-360"/);
  assert.match(editor, /max="360"/);
  assert.match(editor, /const rawValue = String\(val \?\? ''\)\.trim\(\);/);
  assert.match(editor, /if \(!rawValue \|\| !Number\.isFinite\(numeric\)\)/);
  assert.match(editor, /Math\.min\(360, Math\.max\(-360, numeric\)\)/);
  assert.doesNotMatch(editor, /<div class="se-angle-btns">/);
  assert.doesNotMatch(editor, /data-angle-value/);
});

test('shape editor opens as a fullscreen clean workspace with direct drawing edits', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /width:100vw;height:100vh/);
  assert.match(editor, /se-direct-edit-note/);
  assert.match(editor, /_editSideFromDrawing\(i\)/);
  assert.match(editor, /_editAngleFromDrawing\(i\)/);
  assert.match(editor, /addEventListener\('dblclick'/);
  assert.match(editor, /דאבל-קליק לעריכת אורך/);
  assert.match(editor, /דאבל-קליק לעריכת זווית/);
});
test('shape editor direct-open hides the count picker before edit page', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const match = editor.match(/_goToEdit\(\) \{[\s\S]*?document\.getElementById\('seHeadTitle'\)/);

  assert.ok(match, 'expected _goToEdit body');
  assert.match(match[0], /document\.getElementById\('sePageCount'\)\.style\.display\s*=\s*'none'/);
  assert.match(match[0], /document\.getElementById\('sePageSelect'\)\.style\.display\s*=\s*'none'/);
  assert.match(match[0], /document\.getElementById\('sePageEdit'\)\.style\.display\s*=\s*''/);
});
test('shape editor bypasses the legacy shape selection screen', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const goToSelect = editor.match(new RegExp("_goToSelect\\(\\) \\{[\\s\\S]*?\\n  \\}"));
  const openBlock = editor.match(/open\(existingData\) \{[\s\S]*?\n  \}/);

  assert.ok(goToSelect, 'expected _goToSelect body');
  assert.match(goToSelect[0], /this\._startDefaultEdit\(this\._selectedFamily \|\| 'bars'\)/);
  assert.doesNotMatch(goToSelect[0], /sePageSelect'\)\.style\.display\s*=\s*'flex'/);
  assert.ok(openBlock, 'expected open block');
  assert.match(openBlock[0], /this\._startDefaultEdit\('bars'\)/);
});

test('shape editor family tabs switch directly to family editors', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const jumpToFamily = editor.match(new RegExp("_jumpToFamily\\(family\\) \\{[\\s\\S]*?\\n  \\}"));

  assert.ok(jumpToFamily, 'expected _jumpToFamily body');
  assert.match(jumpToFamily[0], /this\._startDefaultEdit\(this\._selectedFamily\)/);
  assert.doesNotMatch(jumpToFamily[0], /this\._goToSelect\(\)/);
});

test('shape editor one-screen edit layout keeps editing inside the viewport', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /One-screen shape edit layout/);
  assert.match(editor, /#sePageEdit\{[\s\S]*height:calc\(100vh - 132px\)/);
  assert.match(editor, /#seModal \.se-svg-wrap\{[\s\S]*height:calc\(100vh - 254px\)/);
  assert.match(editor, /#seModal \.se-table-wrap\{[\s\S]*overflow-y:auto/);
  assert.match(editor, /#sePageEdit\{[\s\S]*overflow:hidden/);
  assert.match(editor, /#seModal \.se-table-wrap\{[\s\S]*overflow-x:hidden/);
  assert.match(editor, /#seModal \.se-table\.se-table-3d tr\{[\s\S]*grid-template-columns:28px minmax\(0,1fr\) minmax\(0,.72fr\) minmax\(0,.66fr\) 22px/);
  assert.match(editor, /#seModal \.se-foot\{[\s\S]*height:68px/);
});

test('shape editor keeps selection and pile fields readable on a narrow phone', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /#seFamilyTabs\{justify-content:flex-start!important;[\s\S]*overflow-x:auto!important;[\s\S]*flex-wrap:nowrap!important/);
  assert.match(editor, /#sePageSelect #sePresets\{[\s\S]*grid-template-columns:repeat\(auto-fill,minmax\(58px,1fr\)\)!important/);
  assert.match(editor, /\.se-pile-section-row td\{grid-column:1\/-1!important;width:100%!important;min-width:0!important;display:block/);
  assert.match(editor, /se-family-row>td\[colspan="2"\]\{grid-column:auto!important;width:auto!important;display:block;\}/);
  assert.match(editor, /@media\(max-width:420px\)\{[\s\S]*se-pile-section \.se-family-row\{grid-template-columns:1fr!important;\}/);
  assert.match(editor, /#sePageEdit\{[\s\S]*grid-template-rows:auto minmax\(220px,32dvh\) auto!important;[\s\S]*overflow-y:auto!important/);
  assert.match(editor, /#sePageEdit \.se-data-panel\{[\s\S]*overflow:visible!important/);
  assert.match(editor, /#seModal \.se-table-wrap\{[\s\S]*height:auto!important;[\s\S]*overflow:visible!important/);
});

test('shape editor keeps bend parameter rows compact and technical', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /#seModal \.se-field-shell \.se-input\{[\s\S]*min-height:24px/);
  assert.match(editor, /#seModal \.se-field-shell \.se-input\{[\s\S]*font-size:12px/);
  assert.match(editor, /#seModal \.se-table\.se-table-2d tr\{[\s\S]*minmax\(0,\.58fr\)/);
  assert.match(editor, /#seModal \.se-param-example\{display:none;\}/);
  assert.match(editor, /grid-template-columns:360px minmax\(0,1fr\) 154px/);
  assert.match(editor, /td\.se-empty-cell\{background:transparent/);
  assert.match(editor, /class=\"se-pile-section\"/);
  assert.match(editor, /sectionSummary/);
  assert.ok(editor.includes('se-family-row>td[colspan]{grid-column:1/-1!important;width:100%;min-width:0;display:block;}'));
  assert.ok(editor.includes('se-pile-hoop-grid{display:grid;grid-template-columns:24px repeat(3,minmax(50px,1fr))'));
  assert.ok(editor.includes('se-pile-elements{border:1px solid #d8e2ec;border-radius:7px;background:#fff;padding:5px;display:grid;gap:4px;width:100%;min-width:0;overflow:hidden;}'));
  assert.match(editor, /class="se-angle-cell \$\{i < angles\.length \? '' : 'se-empty-cell'\}"/);
  assert.match(editor, /class="se-no-bend"/);
});

test('shape editor draws non-right bend angles as small arc labels without a tag box', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const bendBlock = editor.match(/Bend marks:[\s\S]*?svg\.innerHTML = html/);

  assert.ok(bendBlock, 'expected bend marker rendering block');
  assert.match(bendBlock[0], /A \$\{r\.toFixed\(1\)\}/);
  assert.match(bendBlock[0], /font-size="9"/);
  assert.doesNotMatch(bendBlock[0], /<rect x="\$\{\(-tagW\/2\)/);
});

test('shape editor approved reference UI keeps Hebrew workspace chrome', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /Approved TENA reference layout - UI only/);
  assert.match(editor, /src="\/brand\/tene-pdf-logo\.jpg"/);
  assert.match(editor, /id="seStepIndicator"/);
  assert.match(editor, /class="se-family-panel"/);
  assert.match(editor, /data-edit-family="bars"/);
  assert.match(editor, /data-edit-family="mesh"/);
  assert.match(editor, /data-edit-family="piles"/);
  assert.match(editor, /class="se-field-shell"/);
  assert.doesNotMatch(editor, /<span class="se-param-icon"/);
  assert.doesNotMatch(editor, /<span class="se-param-code"/);
  assert.doesNotMatch(editor, /<span class="se-param-number"/);
  assert.match(editor, /id="seTotalWeight"/);
  assert.match(editor, /id="seQuantityInput"/);
  assert.match(editor, /_focusFamilyField/);
  assert.match(editor, /_applyFamilyFocus/);
  assert.doesNotMatch(editor, /Mesh Editor/);
  assert.doesNotMatch(editor, /Pile Cage Editor/);
  assert.doesNotMatch(editor, /Side Lengths \/ Bend Angles/);
});


test('shape editor does not embed a page-local UI tuning panel', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.doesNotMatch(editor, /seUiTunePanel/);
  assert.doesNotMatch(editor, /seUiTuneBtn/);
  assert.doesNotMatch(editor, /se-ui-tune/);
  assert.doesNotMatch(editor, /ironbend\.shapeEditor\.uiTune/);
});
test('shape editor connects parameter fields to drawing focus targets', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /_inferFieldShellMeta/);
  assert.match(editor, /data-se-param="\$\{focusKey\}"/);
  assert.match(editor, /onfocusin="window\._seEditor\?\._setFieldFocus/);
  assert.match(editor, /se-focus-mode/);
  assert.match(editor, /se-focus-hit/);
  assert.match(editor, /data-se-focus="mesh-longitudinal-bars mesh-longitudinal-diameter mesh-longitudinal-spacing"/);
  assert.match(editor, /data-se-focus="pile-spiral-pitch pile-spiral-diameter pile-zone"/);
  assert.match(editor, /data-se-focus="bar-side-\$\{i\}"/);
  assert.match(editor, /data-se-focus="bar-angle-\$\{i\}"/);
});

test('shape editor focuses Z angle fields without switching to side length editing', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /if \(el !== ''\) meta = \{ \.\.\.meta, focusKey: `bar-z-\$\{el\}`/);
  assert.match(editor, /data-el="\$\{i\}" onfocus="window\._seEditor\._focusRow\(\$\{i\}, 'z'\)"/);
  assert.ok(editor.includes("focusAngle === 'z' ? '[data-el]'"));
  assert.doesNotMatch(editor, /if \(el\) meta = \{ \.\.\.meta, focusKey: `bar-side-\$\{el\}`/);
});

test('shape editor includes pile cage 2D engineering views without 3D helper output', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const pileRenderBlock = editor.match(/PileCageEngine\.render = function\(pile, w = 300, h = 260\) \{[\s\S]*?\n\};/);

  assert.ok(pileRenderBlock, 'expected PileCageEngine renderer block');
  assert.match(pileRenderBlock[0], /data-view=\"side\"/);
  assert.match(pileRenderBlock[0], /data-view=\"top\"/);
  assert.match(pileRenderBlock[0], /pile-side-engineering-view/);
  assert.match(pileRenderBlock[0], /pile-top-engineering-view/);
  assert.match(pileRenderBlock[0], /pile-zone-dimension/);
  assert.match(pileRenderBlock[0], /pile-pitch-label/);
  assert.match(pileRenderBlock[0], /pile-spiral-loop/);
  assert.match(editor, /data-se-focus="mesh-longitudinal-spacing mesh-transverse-spacing"/);
  assert.doesNotMatch(pileRenderBlock[0], /data-view=\"3d\"/);
  assert.doesNotMatch(pileRenderBlock[0], /se-engineer-helper/);
});

test('shape editor renders one row per side in the 2D dimensions panel', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /One-row side editor/);
  assert.match(editor, /const letter = String\.fromCharCode\(65 \+ i\)/);
  assert.match(editor, /<tr class=\"se-side-row\">/);
  assert.match(editor, /class=\"se-length-cell\"/);
  assert.match(editor, /class=\"se-angle-cell/);
  assert.match(editor, /se-empty-cell/);
  assert.doesNotMatch(editor, /html \+= `<tr class=\"se-bend-row\">/);
});
test('shape editor has mesh and pile families with icon-only preset buttons', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /const SHAPE_FAMILIES = \[/);
  assert.match(editor, /id: 'mesh1'/);
  assert.match(editor, /id: 'round-pile-cage'/);
  assert.match(editor, /id="seFamilyTabs"/);
  const presetRender = editor.match(/_renderPresets\(countFilter\) \{[\s\S]*?_renderSavedShapes\(countFilter\) \{/);
  assert.ok(presetRender, 'expected preset renderer block');
  assert.match(presetRender[0], /shapePresetIconSVG\(s\.icon \|\| 'straight'\)/);
  assert.match(presetRender[0], /class="se-preset-name"/);
  assert.doesNotMatch(presetRender[0], /font-size:12px;font-weight:700;line-height:1\.3;word-break:break-word;color:inherit/);
});
test('shape editor built-in preset names stay neutral', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const presetBlock = editor.match(/const SHAPE_PRESETS = \[([\s\S]*?)\];/);

  assert.ok(presetBlock, 'expected shape preset block');
  assert.match(presetBlock[0], /name: 'צורה 2'/);
  assert.match(presetBlock[0], /name: 'רשת'/);
  assert.match(presetBlock[0], /name: 'כלוב כלונס עגול'/);
  assert.doesNotMatch(presetBlock[0], /אנקר|הזזה|כפול|אוברל|אסדה|אצבה|כיפופים|חמש צלעות|סימטרית|בסיס/);
});
test('round pile cage preset exposes a parametric form and engineering visualization', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /name: 'כלוב כלונס עגול'/);
  ['straightBarCount', 'bentBarCount', 'straightBarLength', 'bentBarLength', 'bendLength', 'spiralOuterDiameter', 'spiralPitch', 'hoopOuterDiameter', 'hoopQuantity'].forEach(field => assert.match(editor, new RegExp(field)));
  assert.match(editor, /קוטר כלונס \(ס״מ\)/);
  assert.match(editor, /קוטר ברזל מוטות \(מ״מ\)/);
  assert.match(editor, /מרווח טבעות \(ס״מ\)/);
  assert.match(editor, /data-pile-derived="spiralTurns"/);
  assert.match(editor, /\$\{displaySpiralTurns\} ↻/);
  assert.match(editor, /spiralTurnsOut\.textContent = `\$\{displayTurns\} ↻`/);
  assert.doesNotMatch(editor, /ליפופים מחושבים/);
  assert.match(editor, /componentType === 'spiral_consolidated'/);
  assert.match(editor, /consolidatedSpiral\?\.schedule/);
  assert.match(editor, /_setSpiralZoneField\(index, key, val\)[\s\S]*?_refreshPileDerived\(\)/);
  assert.match(editor, /קוטר טבעת/);
  assert.match(editor, /מרווח נקי/);
  assert.match(editor, /id="sePileComponentGallery"/);
  assert.match(editor, /_pileComponentCardsHtml\(\)/);
  assert.match(editor, /class="se-pile-group-tabs"/);
  assert.match(editor, /data-pile-group-tab="\$\{id\}"/);
  assert.match(editor, /data-pile-component-section="\$\{section\}"/);
  assert.match(editor, /@media\(max-width:760px\)[\s\S]*?\.se-pile-component-gallery\{[\s\S]*?grid-auto-flow:column/);
  assert.match(editor, /@media\(min-width:761px\) and \(max-width:1100px\)/);
  assert.doesNotMatch(editor, /�/);
  assert.match(editor, /calculateRoundPileCage/);
  assert.match(editor, /\['spiral', 'ספירלה'/);
  assert.match(editor, /data-zone-field="noWrap"/);
  assert.match(editor, />\+ מקטע<\/button>/);
  assert.doesNotMatch(editor, /הוסף פער|אזורי ספירלה ופערים/);
  assert.match(editor, /data-view="side"/);
  assert.match(editor, /data-view="top"/);
});
test('shape editor exposes the requested Easybar category filters', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /const SHAPE_CATEGORY_FILTERS = \['הכל', 'חישוק', 'פיגורה', 'ספירלים', 'ציפורים', 'משקפיים', 'קלמרה'\]/);
  assert.match(editor, /id="seCategoryFilters"/);
  assert.match(editor, /class="se-category-filter/);
  assert.match(editor, /s\.category === category/);
});
test('shape editor exposes side-count filters for built-in and saved shapes', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /const SHAPE_SIDE_FILTERS = \['הכל', 1, 2, 3, 4, 5, 6, 7, 8\]/);
  assert.match(editor, /id="seSideFilters"/);
  assert.match(editor, /class="se-side-filter/);
  assert.match(editor, /const sideCount = this\._selectedSideCount/);
  assert.match(editor, /\(s\.sides \|\| \[\]\)\.length === sideCount/);
});

test('shape editor defaults newly added 3D side bends to 90 degrees', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const addSideBlock = editor.match(new RegExp('_addSide\\(\\) \\{[\\s\\S]*?\\n  \\}'));

  assert.ok(addSideBlock, 'expected _addSide body');
  assert.match(addSideBlock[0], /this\.current\.angles\.push\(90\)/);
  assert.match(addSideBlock[0], /this\.current\.azAngles\.push\(90\)/);
  assert.doesNotMatch(addSideBlock[0], /this\.current\.azAngles\.push\(0\)/);
});


test('shape editor keeps default 90-degree 3D turns positive, not negative', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /angles\.map\(a => 180 - \(a \?\? 180\)\)/);
  assert.match(editor, /this\.current\.azAngles\[i \+ 1\] = 180 - a/);
  assert.match(editor, /const ang2d = 180 - az/);
  assert.doesNotMatch(editor, /-\(180 - \(a \?\? 180\)\)/);
  assert.doesNotMatch(editor, /azAngles\[i \+ 1\] = -\(180 - a\)/);
});

test('shape editor renders closed stirrup overlap instead of drawing the overlap as another polygon side', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /function detectClosedStirrupParts/);
  assert.match(editor, /function renderClosedStirrupEditor2D/);
  assert.match(editor, /data-shape-kind="closed-stirrup"/);
  assert.match(editor, /data-stirrup-marker="overlap"/);
  assert.match(editor, /const stirrupParts = detectClosedStirrupParts\(sides, angles\)/);
  assert.match(editor, /renderClosedStirrupEditor2D\(stirrupParts, sides, 300, 260/);
});

test('shape editor active segment selection does not recolor the drawn bar', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.doesNotMatch(editor, /stroke="\$\{isActive \? '#2979ff' : SEG_GRAY\}" stroke-width="4"/);
  assert.match(editor, /const color = bodyStroke/);
  assert.doesNotMatch(editor, /Active segment overlay/);
  assert.doesNotMatch(editor, /stroke="#2979ff" stroke-width="4"/);
  assert.doesNotMatch(editor, /stroke="rgba\(41,121,255,[^`]*stroke-width/);
  assert.doesNotMatch(editor, /drop-shadow\(0 0 [^)]*rgba\(41,121,255/);
  assert.doesNotMatch(editor, /barW\*4\.5/);
});

test('shape editor index loads a fresh shape editor asset version', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(index, /steelRebarShapes\.js\?v=1/);
  assert.match(index, /shape-editor\.js\?v=78/);
  assert.doesNotMatch(index, /shape-editor\.js\?v=(?:62|63|64|65|66|67)/);
});

test('standalone ring family icon reads as a closed circular ring with overlap', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /ring: `<circle cx="50" cy="48" r="28" \$\{thin\}\/><path \$\{thin\} d="M30 68 C37 76 47 80 59 77"\/>`/);
  assert.doesNotMatch(editor, /ring: `<path \$\{thin\} d="M28 64 A30 30/);
});

test('spiral family icon reads as a multi-turn coil with a diameter line', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /spiral: `<path \$\{thin\} d="M39 84 A36 36 0 1 1 67 80"\/><circle cx="50" cy="48" r="26"/);
  assert.match(editor, /M12 48 H88 M12 42 V54 M88 42 V54/);
});

test('standalone ring editor keeps overlap in the Shape V2 cut length', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const { buildShapeDataContractV2, RingEngine } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'spirals',
    shapeType: 'ring',
    specialty: 'ring',
    presetId: 'ring1',
    presetName: 'טבעת עגולה',
    barDiameter: 18,
    ringDiameter: 420,
    spiralDiameter: 420,
    overlap: 200,
    turns: 1,
  });

  assert.match(editor, /data-edit-family="ring"/);
  assert.match(editor, /seRingDiameter/);
  assert.match(editor, /seRingOverlap/);
  assert.match(editor, /אורך חיתוך כולל חפיפה/);
  assert.equal(contract.family, 'spirals');
  assert.equal(contract.shapeType, 'ring');
  assert.equal(contract.data.ringDiameterMm, 420);
  assert.equal(contract.data.overlapMm, 200);
  assert.equal(contract.calculated.circumferenceMm, 1319);
  assert.equal(contract.calculated.totalLengthMm, 1519);
  assert.equal(contract.validation.valid, true);
  assert.equal(Object.hasOwn(contract.data, 'quantity'), false);
  assert.match(RingEngine.render({ barDiameter: 18, ringDiameter: 420, overlap: 200 }, 300, 260), /data-overlap-mm="200"/);
});

test('production card renders a standalone ring and its overlap', () => {
  const svg = itemShapeSvg({
    family: 'spirals',
    spiral_diameter_mm: 420,
    spiral_turns: 1,
    shapeSnapshot: {
      family: 'spirals',
      shapeType: 'ring',
      data: { shapeType: 'ring', barDiameter: 18, ringDiameterMm: 420, spiralDiameter: 420, turns: 1, overlapMm: 200 },
      calculated: { totalLengthMm: 1519 },
      machineOutput: { generic: {} },
    },
  });

  assert.match(svg, /data-shape-kind="ring"/);
  assert.match(svg, /data-ring-overlap-mm="200"/);
  assert.match(svg, /data-scale-mode="container-fit"/);
  assert.doesNotMatch(svg, /max-height:/);
  assert.match(svg, /data-ring-overlap-dimension="1"/);
  assert.match(svg, />חפיפה</);
  assert.match(svg, />20 ס״מ</);
});

test('compact ring preview points the 20 cm label at the overlap arc', () => {
  const { RingEngine } = loadShapeEditorGeometry();
  const svg = RingEngine.render({ shapeType: 'ring', barDiameter: 18, ringDiameter: 420, overlap: 200 }, 112, 88);
  assert.match(svg, /data-ring-overlap-dimension="1"/);
  assert.match(svg, /חפיפה 20 ס״מ/);
});


test('shape editor summary weight stays per shape unit and does not multiply by order quantity', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /set\('seTotalWeight', weightKg\.toFixed\(2\)\)/);
  assert.doesNotMatch(editor, /set\('seTotalWeight', \(weightKg \* qty\)\.toFixed\(2\)\)/);
});

test('shape editor exposes editable order item quantity outside the shape contract', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /id="seQuantityInput"/);
  assert.match(editor, /_setQuantity\(value\)/);
  assert.match(editor, /orderItemQuantity/);
  assert.match(editor, /delete normalized\.quantity/);
  assert.match(editor, /delete normalized\.qty/);
});


test('shape editor edits a straight bar with the unified bar layout and saves Shape V2 straight_bar', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'bars',
    sides: [1250],
    angles: [],
    diameter: 16,
    quantity: 7,
  });

  // Straight and bent bars share one layout: the side table (in cm) plus a
  // diameter and quantity field in the footer — no separate straight-bar form.
  assert.match(editor, /data-side="\$\{i\}"/);
  assert.match(editor, /id="seDiameterSelect"/);
  assert.match(editor, /id="seQuantityInput"/);
  assert.match(editor, /_setSide\(i, val\)/);
  assert.doesNotMatch(editor, /id="seStraightLengthInput"/);
  assert.equal(contract.contractVersion, 2);
  assert.equal(contract.family, 'bars');
  assert.equal(contract.shapeType, 'straight_bar');
  assert.deepEqual(contract.data.sides, [1250]);
  assert.deepEqual(contract.data.angles, []);
  assert.equal(contract.data.diameter, 16);
  assert.equal(contract.calculated.totalLengthMm, 1250);
  assert.equal('quantity' in contract.data, false);
});

test('new order item rows render a visible shape preview from length fallback', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(index, /function itemShapeSides\(item = \{\}\)/);
  assert.match(index, /item\.length \?\? item\.totalLengthMm \?\? item\.total_length_mm/);
  assert.match(index, /const sides = itemShapeSides\(item\);/);
  assert.match(index, /const sides = itemShapeSides\(item \|\| \{\}\);/);
  assert.match(index, /const W = 180, H = 96, padX = 28, padY = 22/);
});

test('manual add item opens the shape editor before creating an empty order row', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const addItemBlock = index.match(new RegExp('function addItem\\(palletId\\) \\{[\\s\\S]*?\\n\\}'));
  const shapeSelectedBlock = index.match(new RegExp('function shapeSelected\\(data\\) \\{[\\s\\S]*?\\n\\}'));

  assert.ok(addItemBlock, 'expected addItem body');
  assert.ok(shapeSelectedBlock, 'expected shapeSelected body');
  assert.match(addItemBlock[0], /pendingItem/);
  // New items open the editor with diameter and quantity empty (0) so the
  // editor requires them, and carry the item number for context.
  assert.match(addItemBlock[0], /shapeEditor\.open\(\{ quantity: 0, diameter: 0, itemNumber/);
  assert.doesNotMatch(addItemBlock[0], /pallet\.items\.push/);
  assert.match(shapeSelectedBlock[0], /pallet\.items\.push\(item\)/);
  assert.match(shapeSelectedBlock[0], /data\.orderItemQuantity/);
});

test('smooth Ø8 and Ø10 remain distinct saved material specifications without changing geometry', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const quickEntry = fs.readFileSync(path.join(__dirname, '..', 'public', 'new-order-editor.js'), 'utf8');
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const smooth = buildShapeDataContractV2({ family: 'bars', sides: [1200], angles: [], diameter: 8, steelFinish: 'smooth' });
  const ribbed = buildShapeDataContractV2({ family: 'bars', sides: [1200], angles: [], diameter: 8 });

  assert.match(editor, /'8\|smooth'/);
  assert.match(editor, /'10\|smooth'/);
  assert.match(quickEntry, /'8\|smooth'/);
  assert.equal(smooth.data.diameter, 8);
  assert.equal(smooth.data.steelFinish, 'smooth');
  assert.equal(ribbed.data.steelFinish, undefined);
  assert.equal(smooth.calculated.totalLengthMm, ribbed.calculated.totalLengthMm);
  assert.equal(smooth.calculated.weightKg, ribbed.calculated.weightKg);
});

test('a new shape-editor item clears the preceding geometry instead of reusing defaults', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const openStart = editor.indexOf('  open(existingData) {');
  assert.ok(openStart >= 0, 'expected shape editor open body');
  const openBlock = editor.slice(openStart, openStart + 5000);
  assert.match(openBlock, /this\._blankNewEntry = !existingData\?\.presetId/);
  assert.match(openBlock, /if \(this\._blankNewEntry\) this\.current = null/);
  assert.match(editor, /const isBlankNewEntry = this\._blankNewEntry === true/);
  assert.match(editor, /\.map\(value => isBlankNewEntry \? 0 : value\)/);
  assert.match(editor, /diameter:\s+isBlankNewEntry \? 0/);
  assert.match(editor, /quantity:\s+isBlankNewEntry \? 0/);
  assert.match(editor, /straightLengthInput\.value = String\(value\)/);
  assert.match(editor, /if \(!raw \|\| !Number\.isFinite\(lengthCm\) \|\| lengthCm <= 0\) \{/);
  assert.match(editor, /this\.current\.sides\[i\] = Math\.round\(lengthCm \* 10\);/);
  assert.match(editor, /const sidesOk = Array\.isArray\(this\.current\.sides\)/);
});

test('clearing a dimension while typing keeps the last valid side and angle until the field is committed', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const attributes = new Map();
  const input = {
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  context.document = {
    querySelector() { return input; },
    querySelectorAll() { return []; },
  };
  const modal = Object.create(ShapeEditorModal.prototype);
  modal.current = { sides: [1010], angles: [90] };
  let previewUpdates = 0;
  modal._updatePreview = () => { previewUpdates += 1; };

  modal._setSide(0, '');
  modal._setAngle(0, '');
  assert.deepEqual(Array.from(modal.current.sides), [1010]);
  assert.deepEqual(Array.from(modal.current.angles), [90]);
  assert.equal(previewUpdates, 0);
  assert.equal(attributes.get('aria-invalid'), 'true');

  modal._setSide(0, '101');
  modal._setAngle(0, '95');
  assert.deepEqual(Array.from(modal.current.sides), [1010]);
  assert.deepEqual(Array.from(modal.current.angles), [95]);
  assert.equal(previewUpdates, 2);
  assert.equal(attributes.has('aria-invalid'), false);
});

test('preview rendering is coalesced to one animation frame during fast camera input', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const frames = [];
  context.window.requestAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  context.window.cancelAnimationFrame = () => {};
  const modal = Object.create(ShapeEditorModal.prototype);
  let renders = 0;
  modal._renderPreviewNow = () => { renders += 1; };

  modal._updatePreview();
  modal._updatePreview();
  modal._updatePreview();
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(renders, 1);
});

test('shape editor keeps true 3D angle fields in sync with visual bends', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.match(editor, /_init3DAnglesFrom2D\(render = true\)/);
  assert.match(editor, /isReal3D && angles\?\.length > 0 && \(!azAngles \|\| azAngles\.every/);
  assert.match(editor, /this\._init3DAnglesFrom2D\(false\);/);
  assert.match(editor, /\(\{ sides, angles, azAngles, elAngles \} = this\.current\);/);
});

test('ShapeEngineRouter renders ח 35/120/35 with PolylineBarEngine', () => {
  const { ShapeEngineRouter, PolylineBarEngine } = loadShapeEditorGeometry();
  const shape = { family: 'bars', sides: [350, 1200, 350], angles: [90, 90] };
  const svg = ShapeEngineRouter.render(shape, 300, 260, { view: '2d' });

  assert.equal(ShapeEngineRouter(shape), PolylineBarEngine);
  assert.match(svg, /data-engine="PolylineBarEngine"/);
  assert.match(svg, /M /);
  assert.match(svg, />35 ס״מ</);
  assert.match(svg, />120 ס״מ</);
  assert.match(svg, />90°</);
});

test('ShapeEngineRouter renders Mesh 600x250 Ø8@20 as grid with MeshEngine', () => {
  const { ShapeEngineRouter, MeshEngine } = loadShapeEditorGeometry();
  const mesh = {
    family: 'mesh',
    length: 600,
    width: 250,
    longitudinalDiameter: 8,
    longitudinalSpacing: 20,
    transverseDiameter: 8,
    transverseSpacing: 20,
  };
  const svg = ShapeEngineRouter.render(mesh, 300, 260);

  assert.equal(ShapeEngineRouter(mesh), MeshEngine);
  assert.match(svg, /data-engine="MeshEngine"/);
  assert.match(svg, /data-family="mesh"/);
  assert.match(svg, /data-length="600"/);
  assert.match(svg, /data-width="250"/);
  assert.match(svg, /data-longitudinal="Ø8@20 ס״מ"/);
  assert.match(svg, /data-transverse="Ø8@20 ס״מ"/);
  assert.ok((svg.match(/<line /g) || []).length >= 40, 'expected mesh grid lines');
});


test('shape editor switches to a mesh editor without side or angle fields', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const block = editor.match(/_renderMeshEditor\(\) \{[\s\S]*?[\r\n]+  \}[\r\n]+[\r\n]+  _renderPileCageEditor/);

  assert.ok(block, 'expected mesh editor renderer');
  for (const field of ['length', 'width', 'longitudinalDiameter', 'longitudinalSpacing', 'transverseDiameter', 'transverseSpacing', 'edgeLeft', 'edgeRight', 'edgeTop', 'edgeBottom']) {
    assert.ok(block[0].includes(`'${field}'`));
  }
  assert.doesNotMatch(block[0], /data-side=/);
  assert.doesNotMatch(block[0], /data-angle=/);
  assert.match(editor, /this\.current\.family === 'mesh'\)\s+return this\._renderMeshEditor\(\)/);
});

test('shape editor switches to a pile cage editor with editable spiral zones', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const block = editor.match(/_renderPileCageEditor\(\) \{[\s\S]*?[\r\n]+  \}[\r\n]+[\r\n]+  _renderBarEditor/);

  assert.ok(block, 'expected pile cage editor renderer');
  for (const field of ['pileDiameter', 'pileLength', 'longitudinalBars', 'longitudinalDiameter', 'spiralDiameter', 'spiralType', 'hoopsEnabled', 'hoopDiameter', 'hoopSpacing', 'hoopStart', 'hoopEnd', 'barPattern', 'lHookLength']) {
    assert.ok(block[0].includes(`'${field}'`));
  }
  for (const field of ['name', 'length', 'pitch', 'noWrap']) {
    assert.match(block[0], new RegExp(`data-zone-field="${field}"`));
  }
  assert.match(editor, /_addSpiralZone\(\)/);
  assert.match(editor, /_deleteSpiralZone\(index\)/);
  assert.doesNotMatch(block[0], /data-side=/);
  assert.doesNotMatch(block[0], /data-angle=/);
  assert.match(editor, /this\.current\.family === 'piles'\)\s+return this\._renderPileCageEditor\(\)/);
});

test('pile cage editor refreshes derived hoops and gates longitudinal shape rows', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const start = editor.indexOf('_renderPileCageEditor() {');
  const end = editor.indexOf('_renderBarEditor', start);
  const block = editor.slice(start, end);

  assert.ok(start > 0 && end > start, 'expected pile cage editor block before longitudinal rows helper');
  assert.ok(block.includes('data-pile-derived="internalHoopDiameter"'));
  assert.ok(block.includes('${this._renderPileLongitudinalShapeRows(field)}'));
  assert.equal(block.includes("${field('lHookLength', 0)}</tr>"), false);
  assert.ok(editor.includes('_refreshPileDerived()'));
  assert.ok(editor.includes('data-pile-derived="internalHoopDiameter"'));
  assert.ok(editor.includes('diameterOut.textContent = diameterOut.classList'));
  assert.ok(editor.includes('data-pile-derived="barCenterSpacing"'));
  assert.ok(editor.includes('data-pile-derived="barClearSpacing"'));
  assert.ok(editor.includes("pattern === 'straight'"));
  assert.ok(editor.includes("pattern === 'alternate'"));
  assert.ok(editor.includes('data-pile-bar-editor'));
  assert.ok(editor.includes('se-pile-compact-row'));
  assert.ok(editor.includes('se-pile-bar-override-row'));
  assert.ok(editor.includes('data-pile-bar-field="diameter"'));
  assert.ok(editor.includes('se-pile-hoop-grid'));
  assert.ok(editor.includes('hoopStartSide'));
  assert.ok(editor.includes('data-pile-elements-summary'));
  assert.ok(editor.includes('_renderPileElementsSummary()'));
  assert.ok(editor.includes('_refreshPileElementsSummary()'));
  assert.ok(editor.includes('_addPileBarOverride()'));
  assert.ok(editor.includes('_deletePileBarOverride(index)'));
  assert.doesNotMatch(block, /עריכה פרטנית תוגדר בהמשך/);
  assert.ok(editor.includes("field('lHookLength', 0) + field('bendAngle', 0) + '</div>'"));
  const barPatternBranch = editor.slice(editor.indexOf("key === 'barPattern'"), editor.indexOf("const parsed = key === 'longitudinalBars'"));
  assert.ok(barPatternBranch.includes('this._renderPileCageEditor()'));
});

test('PileCageEngine derives internal hoop diameter and weld spacing from spiral and longitudinal bars', () => {
  const { PileCageEngine } = loadShapeEditorGeometry();
  const result = PileCageEngine.calculate({
    family: 'piles',
    pileDiameter: 40,
    pileLength: 2200,
    longitudinalBars: 6,
    longitudinalDiameter: 16,
    spiralDiameter: 8,
    spiralZones: [{ name: 'Zone A', length: 2200, pitch: 20 }],
    hoopsEnabled: true,
    hoopDiameter: 14,
    hoopSpacing: 200,
    hoopStart: 0,
    hoopEnd: 2200,
  });

  assert.equal(result.calculated.internalHoopDiameterMm, 352);
  assert.equal(result.calculated.hoopCutLengthMm, 1105.8);
  assert.equal(result.calculated.barCenterSpacingMm, 176);
  assert.equal(result.calculated.barClearSpacingMm, 160);
  assert.equal(result.machineOutput.generic.internalHoopDiameterMm, 352);
  assert.equal(result.machineOutput.generic.barCenterSpacingMm, 176);
});

test('PileCageEngine counts hoop spacing from the selected side', () => {
  const { PileCageEngine } = loadShapeEditorGeometry();
  const base = {
    family: 'piles',
    pileDiameter: 70,
    pileLength: 100,
    longitudinalBars: 6,
    longitudinalDiameter: 16,
    spiralDiameter: 8,
    spiralZones: [{ name: 'Zone A', length: 100, pitch: 20 }],
    hoopsEnabled: true,
    hoopDiameter: 14,
    hoopSpacing: 30,
    hoopStart: 0,
    hoopEnd: 100,
  };
  const fromStart = PileCageEngine.calculate({ ...base, hoopStartSide: 'start' });
  const fromEnd = PileCageEngine.calculate({ ...base, hoopStartSide: 'end' });
  const startHoops = fromStart.manufacturingBreakdown.find(part => part.componentType === 'hoop_ring');
  const endHoops = fromEnd.manufacturingBreakdown.find(part => part.componentType === 'hoop_ring');

  assert.deepEqual(startHoops.positionsMm, [0, 300, 600, 900]);
  assert.deepEqual(endHoops.positionsMm, [100, 400, 700, 1000]);
});
test('MeshEngine spacing changes grid count while diameter changes bar thickness', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const base = { family: 'mesh', length: 600, width: 250, longitudinalDiameter: 8, longitudinalSpacing: 20, transverseDiameter: 8, transverseSpacing: 20 };
  const widerSpacing = { ...base, longitudinalSpacing: 30 };
  const thicker = { ...base, longitudinalDiameter: 16 };
  const baseSvg = ShapeEngineRouter.render(base, 300, 260);
  const spacingSvg = ShapeEngineRouter.render(widerSpacing, 300, 260);
  const thickSvg = ShapeEngineRouter.render(thicker, 300, 260);

  assert.match(baseSvg, /data-longitudinal-count="31"/);
  assert.match(spacingSvg, /data-longitudinal-count="21"/);
  assert.match(thickSvg, /stroke-width="3\.5"/);
  assert.match(thickSvg, /data-longitudinal-count="31"/);
});

test('PileCageEngine treats pile editor dimension fields as centimeters', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'piles',
    pileDiameter: 50,
    pileLength: 9800,
    longitudinalBars: 6,
    longitudinalDiameter: 16,
    longitudinalBarOverrides: [{ barIndex: 3, diameter: 20, barPattern: 'l', lHookLength: 25 }],
    spiralDiameter: 8,
    spiralZones: [
      { length: 80, pitch: 10, noWrap: true },
      { length: 200, pitch: 10 },
      { length: 700, pitch: 20 },
    ],
    hoopsEnabled: true,
    hoopDiameter: 8,
    hoopSpacing: 200,
    hoopStart: 0,
    hoopEnd: 2200,
  });

  assert.equal(contract.data.pileDiameter, 500);
  assert.equal(contract.data.pileLength, 98000);
  assert.deepEqual(contract.data.spiralZones.map(zone => [zone.length, zone.pitch]), [[800, 100], [2000, 100], [7000, 200]]);
  assert.deepEqual(contract.data.longitudinalBarOverrides, [{ barIndex: 3, diameter: 20, barPattern: 'l', lHookLength: 250 }]);
  assert.deepEqual(contract.machineOutput.generic.longitudinalBarOverrides, [{ barIndex: 3, diameter: 20, barPattern: 'l', lHookLength: 250 }]);
  assert.equal(contract.calculated.spiralCenterDiameterMm, 500);
  assert.equal(contract.calculated.internalHoopDiameterMm, 452);
  const hoopPart = contract.calculated.manufacturingBreakdown.find(part => part.componentType === 'hoop_ring');
  assert.equal(hoopPart.hoopDiameterMm, 452);
  assert.equal(hoopPart.barCenterSpacingMm, 226);
  assert.equal(hoopPart.barClearSpacingMm, 210);
  assert.ok(contract.calculated.totalLengthMm < 1000000);
  assert.ok(contract.calculated.weightKg < 1000);
});

test('ShapeEngineRouter renders pile cage top and side views with PileCageEngine', () => {
  const { ShapeEngineRouter, PileCageEngine } = loadShapeEditorGeometry();
  const pile = {
    family: 'piles',
    pileDiameter: 70,
    pileLength: 2200,
    longitudinalBars: 26,
    longitudinalDiameter: 22,
    spiralZones: [
      { length: 70, pitch: 10 },
      { length: 200, pitch: 20 },
      { length: 1350, pitch: 20 },
    ],
  };
  const svg = ShapeEngineRouter.render(pile, 300, 260);

  assert.equal(ShapeEngineRouter(pile), PileCageEngine);
  assert.match(svg, /data-engine="PileCageEngine"/);
  assert.match(svg, /data-view="side"/);
  assert.match(svg, /data-view="top"/);
  assert.match(svg, /data-pile-diameter="700"/);
  assert.match(svg, /data-input-unit="cm"/);
  assert.match(svg, /data-pile-length="22000"/);
  assert.match(svg, /data-longitudinal-bars="26"/);
  assert.match(svg, /data-spiral-zones="700@100,2000@200,13500@200"/);
  assert.equal((svg.match(/class="pile-longitudinal-bar"/g) || []).length, 26);
  assert.match(svg, /class="pile-side-engineering-view"/);
  assert.match(svg, /class="pile-top-engineering-view"/);
  assert.match(svg, /class="pile-zone-dimension/);
  assert.match(svg, /class="pile-pitch-label"/);
  assert.match(svg, /class="pile-spiral-loop"/);
  assert.match(svg, /L 2200 ס״מ/);
  assert.match(svg, /D/);
  assert.match(svg, /Ø8 מ״מ/);
  assert.doesNotMatch(svg, /data-view="3d"/);
});


test('PileCageEngine pitch changes only the edited spiral zone', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const pile = {
    family: 'piles',
    pileDiameter: 70,
    pileLength: 2200,
    longitudinalBars: 26,
    longitudinalDiameter: 22,
    spiralDiameter: 8,
    spiralZones: [
      { length: 70, pitch: 10 },
      { length: 200, pitch: 20 },
      { length: 1350, pitch: 20 },
    ],
  };
  const changed = {
    ...pile,
    spiralZones: [
      { length: 70, pitch: 10 },
      { length: 200, pitch: 10 },
      { length: 1350, pitch: 20 },
    ],
  };
  const countZone = (svg, zone) => (svg.match(new RegExp(`data-zone="${zone}"`, 'g')) || []).length;
  const baseSvg = ShapeEngineRouter.render(pile, 300, 260);
  const changedSvg = ShapeEngineRouter.render(changed, 300, 260);

  assert.equal(countZone(baseSvg, 0), countZone(changedSvg, 0));
  assert.notEqual(countZone(baseSvg, 1), countZone(changedSvg, 1));
  assert.equal(countZone(baseSvg, 2), countZone(changedSvg, 2));
  assert.match(changedSvg, /data-spiral-diameter="8"/);
  assert.doesNotMatch(changedSvg, /pile-pitch-control/);
});


test('PileCageEngine renders no-wrap zones, hoops, and L longitudinal bars', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const pile = {
    family: 'piles',
    pileDiameter: 70,
    pileLength: 2200,
    longitudinalBars: 26,
    longitudinalDiameter: 22,
    spiralDiameter: 8,
    spiralZones: [
      { length: 70, pitch: 10 },
      { length: 200, pitch: 20, noWrap: true },
      { length: 1350, pitch: 20 },
    ],
    hoopsEnabled: true,
    hoopDiameter: 8,
    hoopSpacing: 200,
    hoopStart: 50,
    hoopEnd: 1800,
    barPattern: 'alternate',
    lHookLength: 250,
  };
  const svg = ShapeEngineRouter.render(pile, 300, 260);

  assert.match(svg, /class="pile-no-wrap-zone"/);
  assert.match(svg, /class="pile-hoop"/);
  assert.match(svg, /class="pile-l-bar"/);
  assert.match(svg, /data-hoop-count="9"/);
  assert.match(svg, /data-bar-pattern="alternate"/);
  assert.match(svg, /data-spiral-zones="700@100,2000@200:no-wrap,13500@200"/);
});

test('round pile cage standard template keeps 60 cm empty, 300 cm at 10 cm and the remainder at 20 cm', () => {
  const context = loadShapeEditorGeometry();
  const zones = context.buildRoundPileCageStandardZones(1200);

  assert.equal(JSON.stringify(zones), JSON.stringify([
    { name: 'A', length: 60, noWrap: true },
    { name: 'B', length: 300, pitch: 10, noWrap: false },
    { name: 'C', length: 840, pitch: 20, noWrap: false },
  ]));
  assert.equal(context.matchesRoundPileCageStandardZones({ pileLength: 1200, spiralZones: zones }), true);
  assert.equal(context.matchesRoundPileCageStandardZones({ pileLength: 1200, spiralZones: zones.map((zone, index) => index === 2 ? { ...zone, pitch: 15 } : zone) }), false);
  assert.equal(JSON.stringify(context.buildRoundPileCageStandardZones(1500)), JSON.stringify([
    { name: 'A', length: 60, noWrap: true },
    { name: 'B', length: 300, pitch: 10, noWrap: false },
    { name: 'C', length: 1140, pitch: 20, noWrap: false },
  ]));
});

test('round pile cage visual editor exposes one canonical template initializer and compact responsive controls', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const svg = ShapeEngineRouter.render({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    barPattern: 'alternate', bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [
      { name: 'A', length: 60, noWrap: true },
      { name: 'B', length: 300, pitch: 10 },
      { name: 'C', length: 840, pitch: 20 },
    ],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  }, 300, 260);
  const roundStart = editor.lastIndexOf('if (pile.roundPileCage) {', editor.indexOf('const allowedSections = new Set'));
  const roundEnd = editor.indexOf('    const hoopRow = () =>', roundStart);
  const roundEditorBlock = roundStart >= 0 && roundEnd > roundStart ? editor.slice(roundStart, roundEnd) : '';

  assert.match(editor, /data-pile-template/);
  assert.match(roundEditorBlock, />סטנדרטית<\/option>/);
  assert.match(roundEditorBlock, /class="se-pile-group-tabs"/);
  assert.match(roundEditorBlock, /data-pile-quick-entry/);
  assert.match(roundEditorBlock, /data-pile-group-tab="\$\{id\}"/);
  assert.match(editor, /data-pile-section-summary="\$\{id\}"/);
  assert.match(editor, /_refreshRoundPileEditorProjection\(\)/);
  assert.match(editor, /_activatePileCageField\(/);
  assert.match(editor, /_syncPileActiveSection\(\)/);
  assert.match(editor, /_bindPileKeyboardFlow\(\)/);
  assert.match(editor, /selectField\('barSpacingDisplayMode',[\s\S]*?\['center','C\/C'\],[\s\S]*?\['clear','CLEAR'\]/);
  assert.doesNotMatch(roundEditorBlock, /se-pile-quick-summary|se-pile-elements-row/);
  assert.match(editor, /@media\(max-width:420px\)[\s\S]*?grid-auto-columns:148px/);
  assert.match(svg, /data-pile-edit="general\|pileLength"/);
  assert.match(svg, /data-pile-edit="spiral\|zone\|0\|noWrap"/);
  assert.match(svg, /data-pile-edit="spiral\|zone\|1\|pitch"/);
  assert.match(svg, /data-pile-edit="hoops\|hoopQuantity"/);
  assert.match(svg, /data-pile-edit="bars\|bendLength"/);
  assert.doesNotMatch(svg, /pile-bar-index/);
});

test('quick-entry round cage editor keeps all ordinary groups visible in one predictable keyboard sequence', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const roundStart = editor.lastIndexOf('if (pile.roundPileCage) {', editor.indexOf('const allowedSections = new Set'));
  const roundEnd = editor.indexOf('    const hoopRow = () =>', roundStart);
  const roundEditorBlock = roundStart >= 0 && roundEnd > roundStart ? editor.slice(roundStart, roundEnd) : '';

  assert.match(roundEditorBlock, /<section class="se-pile-section" data-pile-section="\$\{id\}">/);
  assert.doesNotMatch(roundEditorBlock, /<details class="se-pile-section" data-pile-section="\$\{id\}"/);
  assert.match(editor, /row\.hidden = false/);
  assert.match(editor, /title\.textContent = 'הזנה מהירה'/);
  assert.match(editor, /event\.key !== 'Enter'/);
  assert.match(editor, /input:not\(\[disabled\]\),select:not\(\[disabled\]\)/);
  assert.match(editor, /!control\.closest\('\.se-pile-advanced:not\(\[open\]\)'\)/);
  assert.doesNotMatch(editor, /event\.key === 'Tab'/);
  assert.doesNotMatch(editor, /row\.hidden = section\.dataset\.pileSection !== sectionId/);
  assert.match(roundEditorBlock, /data-pile-element-name[\s\S]*?compactField\('pileDiameter', 1\)\}\$\{compactField\('pileLength', 1\)/);
  assert.match(editor, /compactField\('straightBarCount', 0\)[\s\S]*?compactField\('bentBarCount', 0\)[\s\S]*?compactField\('longitudinalDiameter', 1\)/);
  assert.match(editor, /compactField\('straightBarLength', 1\)\}\$\{compactField\('bendLength', 0\)/);
  assert.doesNotMatch(editor, /compactField\('straightBarLength', 1\)\}\$\{compactField\('bentBarLength', 1\)/);
  assert.match(editor, /compactField\('spiralDiameter', 1\)\}\$\{compactField\('spiralOuterDiameter', 1\)/);
  assert.match(editor, /compactField\('hoopQuantity', 0\)\}\$\{compactField\('hoopDiameter', 1\)\}\$\{compactField\('hoopOuterDiameter', 1\)/);
  assert.match(editor, /<details class="se-pile-advanced">/);
  assert.match(editor, /<details class="se-pile-advanced"><summary tabindex="-1">⋯<\/summary>/);
  assert.match(editor, /bendOrientationField\(\)[\s\S]*?barSpacingDisplayMode/);
});

test('visual-first component strip keeps only approved identity metrics', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const modal = Object.create(ShapeEditorModal.prototype);
  modal._activePileSection = 'spiral';
  modal._activePileComponent = 'spiral_consolidated';
  modal.current = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 60, noWrap: true }, { name: 'B', length: 300, pitch: 10 }, { name: 'C', length: 840, pitch: 20 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  };
  const html = modal._pileComponentCardsHtml();
  const cards = Object.fromEntries([...html.matchAll(/<article[^>]*data-pile-component-card="([^"]+)"[\s\S]*?<\/article>/g)].map(match => [match[1], match[0]]));

  assert.equal(Object.keys(cards).length, 4);
  assert.equal((cards.spiral_consolidated.match(/class="se-pile-component-metric"/g) || []).length, 4);
  assert.match(cards.spiral_consolidated, /Ø8 mm/);
  assert.match(cards.spiral_consolidated, /D 48 cm/);
  assert.match(cards.spiral_consolidated, /72 ↻/);
  assert.match(cards.spiral_consolidated, /CUT [\d,.]+ cm/);
  assert.doesNotMatch(cards.spiral_consolidated, /@|פסיעה|L1|L2|L3|NO WRAP|ללא כריכות|Σ/);
  assert.doesNotMatch(cards.longitudinal_straight_bar, /Σ/);
  assert.doesNotMatch(cards.longitudinal_l_bar, /Σ/);
  assert.doesNotMatch(cards.hoop_ring, /Σ/);
  assert.match(cards.spiral_consolidated, /data-active="true"/);
  Object.values(cards).forEach(card => {
    assert.match(card, /role="button"/);
    assert.match(card, /tabindex="0"/);
    assert.match(card, /aria-pressed="(?:true|false)"/);
    assert.match(card, /data-pile-component-focus="pile-/);
    assert.match(card, /onclick="window\._seEditor\?\._activatePileComponentCard\(this\)"/);
    assert.doesNotMatch(card, /<button/);
  });
});

test('visual-first component selection focuses only its related cage geometry', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const modal = Object.create(ShapeEditorModal.prototype);
  modal.current = { family: 'piles', roundPileCage: true };
  let synced = 0;
  let focusKey = '';
  modal._syncPileActiveSection = () => { synced += 1; };
  modal._focusFamilyField = key => { focusKey = key; };

  modal._activatePileComponentCard({
    dataset: {
      pileComponentCard: 'longitudinal_l_bar',
      pileComponentSection: 'bars',
      pileComponentFocus: 'pile-l-bars',
    },
  });

  assert.equal(modal._activePileComponent, 'longitudinal_l_bar');
  assert.equal(modal._activePileSection, 'bars');
  assert.equal(focusKey, 'pile-l-bars');
  assert.equal(synced, 1);
});

test('visual-first responsive contract uses local component scrolling without page overflow at 390px', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const mobileStart = editor.lastIndexOf('@media(max-width:760px){');
  const mobileEnd = editor.indexOf('@media(max-width:420px){', mobileStart);
  const mobileBlock = mobileStart >= 0 && mobileEnd > mobileStart ? editor.slice(mobileStart, mobileEnd) : '';

  assert.match(editor, /Professional Quick Entry V2: drawing \+ engineering grid/);
  assert.match(mobileBlock, /\.se-data-panel\{flex:0 0 auto!important;min-height:max-content!important/);
  assert.match(editor, /#seModal\.se-pile-editor #sePageEdit \.se-data-panel\{[\s\S]*height:max-content!important;[\s\S]*min-height:max-content!important/);
  assert.match(editor, /#seModal\.se-pile-editor \.se-table-wrap\{flex:none!important;height:auto!important;overflow:visible!important/);
  assert.match(mobileBlock, /\.se-family-editor-table tbody\{display:block!important;height:auto!important/);
  assert.match(mobileBlock, /\.se-pile-engineering-grid\{grid-template-columns:1fr/);
  assert.match(mobileBlock, /\.se-pile-bars-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mobileBlock, /\.se-pile-hoops-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mobileBlock, /grid-auto-columns:minmax\(210px,72vw\)!important/);
  assert.match(mobileBlock, /flex:0 0 auto!important/);
  assert.match(mobileBlock, /min-height:110px/);
  assert.match(editor, /@media\(max-width:760px\)[\s\S]*?grid-auto-flow:column[\s\S]*?overflow-x:auto!important/);
  assert.match(editor, /@media\(max-width:420px\)[\s\S]*?grid-template-rows:28px 236px auto!important/);
});

test('quick-entry main length and bend length project once into the unchanged canonical developed length', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  context.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const modal = Object.create(ShapeEditorModal.prototype);
  modal.current = {
    family: 'piles', roundPileCage: true,
    straightBarLength: 1200, bendLength: 20, bentBarLength: 1220,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
  };
  modal._refreshPileDerived = () => {};
  modal._refreshPileElementsSummary = () => {};
  modal._refreshRoundPileEditorProjection = () => {};
  modal._updatePreview = () => {};
  modal._showPileInputError = () => {};

  modal._setPileField('straightBarLength', 1250);
  assert.equal(modal.current.straightBarLength, 1250);
  assert.equal(modal.current.bentBarLength, 1270);
  modal._setPileField('bendLength', 30);
  assert.equal(modal.current.bendLength, 30);
  assert.equal(modal.current.bentBarLength, 1280);
});

test('round pile cage elevation is illustrative, keeps tooth spirals readable, and exposes exact cm zones', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const svg = ShapeEngineRouter.render({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    barPattern: 'alternate', bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [
      { name: 'A', length: 60, noWrap: true },
      { name: 'B', length: 300, pitch: 10 },
      { name: 'C', length: 840, pitch: 20 },
    ],
    hoopDiameter: 18, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  }, 300, 260);
  const side = svg.match(/<g data-view="side"[\s\S]*?<\/g>/)?.[0] || svg;
  const loopsFor = zone => (svg.match(new RegExp(`class="pile-spiral-loop" data-zone="${zone}"`, 'g')) || []).length;

  assert.match(svg, /L 1200 ס״מ/);
  assert.match(svg, /A · 60 ס״מ/);
  assert.match(svg, /B · 300 ס״מ/);
  assert.match(svg, /C · 840 ס״מ/);
  assert.match(svg, /B · @10 ס״מ/);
  assert.match(svg, /C · @20 ס״מ/);
  assert.doesNotMatch(svg, />600<|>3000<|>8400</);
  assert.equal(loopsFor(0), 0, 'no-wrap zone must not draw spiral steel');
  assert.ok(loopsFor(1) > 0 && loopsFor(1) <= 24);
  assert.ok(loopsFor(2) > 0 && loopsFor(2) <= 24);
  assert.ok((loopsFor(1) / 300) > (loopsFor(2) / 840), '10 cm pitch must read denser than 20 cm pitch');
  assert.match(svg, /d="M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+"/, 'keeps the approved diagonal-plus-return engineering tooth');
  assert.ok(svg.indexOf('class="pile-no-wrap-zone"') < svg.indexOf('class="pile-straight-bar"'), 'transparent no-wrap guide must not cover continuous bars');
  assert.doesNotMatch(side, /L 90°/);
  assert.match(svg, /class="pile-l-bar"[\s\S]*?stroke="#374151"/);
  assert.equal((svg.match(/class="pile-hoop-position"/g) || []).length, 5);
  assert.equal((svg.match(/class="pile-hoop-label"/g) || []).length, 5);
  ['P1', 'P2', 'P3', 'P4', 'P5'].forEach(label => assert.match(svg, new RegExp(`>${label}<`)));
  assert.doesNotMatch(svg, /class="pile-hoop-placement-summary"/, 'five individually labelled hoops need no duplicate summary');
});

test('round pile cage renders the authored hoop quantity and condenses only physical-position labels', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const base = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate', bendOrientationDeg: 45,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopStart: 100, hoopSpacing: 100,
  };

  for (const quantity of [1, 3, 5, 8]) {
    const svg = ShapeEngineRouter.render({ ...base, hoopQuantity: quantity }, 300, 260);
    assert.equal((svg.match(/class="pile-hoop-position"/g) || []).length, quantity, `quantity ${quantity}`);
    assert.match(svg, new RegExp(`data-hoop-position-mm="${1000 + (quantity - 1) * 1000}"`));
    if (quantity <= 6) {
      assert.doesNotMatch(svg, /class="pile-hoop-placement-summary"/);
      for (let index = 1; index <= quantity; index += 1) assert.match(svg, new RegExp(`>P${index}<`));
    } else {
      assert.equal((svg.match(/class="pile-hoop-label"/g) || []).length, 2);
      assert.match(svg, />P1</);
      assert.match(svg, new RegExp(`>P${quantity}<`));
      assert.match(svg, new RegExp(`P1…P${quantity}`));
      assert.doesNotMatch(svg, />P2</);
    }
  }
});

test('round pile cage editor fails closed on the exact out-of-range hoop and has no five-hoop preset fallback', () => {
  const context = loadShapeEditorGeometry();
  const { PileCageEngine } = context.window.IronBendShapeGeometry;
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const base = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate', bendOrientationDeg: 45,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopStart: 700, hoopSpacing: 100,
  };
  const invalid = PileCageEngine.calculate({ ...base, hoopQuantity: 7 });
  const missing = PileCageEngine.calculate({ ...base, hoopQuantity: '' });
  const zero = PileCageEngine.calculate({ ...base, hoopQuantity: 0, hoopDiameter: '', hoopOuterDiameter: '' });
  const zeroSvg = context.ShapeEngineRouter.render({ ...base, hoopQuantity: 0 }, 300, 260);

  assert.equal(invalid.validation.valid, false);
  assert.match(invalid.validation.errors.join('\n'), /P7 at 1300 cm is outside cage length 1200 cm/);
  assert.deepEqual(invalid.data.hoops.positionsMm, [7000, 8000, 9000, 10000, 11000, 12000, 13000]);
  assert.deepEqual(invalid.manufacturingBreakdown, []);
  assert.deepEqual(invalid.productionCards, []);
  assert.equal(missing.validation.valid, false);
  assert.equal(missing.data.hoops.quantity, 0);
  assert.deepEqual(missing.manufacturingBreakdown, []);
  assert.deepEqual(missing.productionCards, []);
  assert.equal(zero.validation.valid, true);
  assert.equal(zero.data.hoops.quantity, 0);
  assert.deepEqual(zero.data.hoops.positionsMm, []);
  assert.equal(zero.manufacturingBreakdown.length, 3);
  assert.ok(!zero.manufacturingBreakdown.some(part => part.componentType === 'hoop_ring'));
  assert.equal(zero.productionCards.length, 4);
  assert.ok(!zero.productionCards.some(card => card.componentType === 'hoop_ring'));
  assert.doesNotMatch(zeroSvg, /class="pile-hoop-position"/);
  assert.doesNotMatch(zeroSvg, /class="pile-hoop-placement-summary"/);
  assert.doesNotMatch(editor, /id:\s*'round-pile-cage'[\s\S]{0,1200}hoopQuantity:\s*5/);
  assert.match(editor, /compactField\('hoopQuantity', 0\)/);
  assert.equal(context.pileFieldAllowsZero('hoopQuantity'), true, 'the live editor must accept an explicitly authored zero quantity');
  assert.equal(context.pileFieldAllowsZero('hoopDiameter'), false, 'material dimensions remain strictly positive when hoops exist');
  assert.equal(
    context.localizePileValidationError('reinforcing hoop position P7 at 1300 cm is outside cage length 1200 cm'),
    'טבעת P7 במיקום 1300 ס״מ נמצאת מחוץ לאורך הכלוב 1200 ס״מ',
  );
  assert.match(editor, /if \(this\.current\.roundPileCage\)[\s\S]{0,200}PileCageEngine\.calculate\(this\.current\)/);
});

test('round pile cage cross-section shows every bar and one selected spacing convention', () => {
  const { ShapeEngineRouter, PileCageEngine, buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const base = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate', bendOrientationDeg: 45,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  };
  const centerSvg = ShapeEngineRouter.render({ ...base, barSpacingDisplayMode: 'center' }, 300, 260);
  const clearSvg = ShapeEngineRouter.render({ ...base, barSpacingDisplayMode: 'clear' }, 300, 260);

  assert.equal((centerSvg.match(/class="pile-longitudinal-bar"/g) || []).length, 10);
  assert.equal((centerSvg.match(/class="pile-bent-head-hook"/g) || []).length, 5);
  assert.match(centerSvg, /data-bar-spacing-mode="center"/);
  assert.match(centerSvg, />C\/C [^<]+ ס״מ</);
  assert.doesNotMatch(centerSvg, />CLEAR [^<]+ ס״מ</);
  assert.match(clearSvg, /data-bar-spacing-mode="clear"/);
  assert.match(clearSvg, />CLEAR [^<]+ ס״מ</);
  assert.doesNotMatch(clearSvg, />C\/C [^<]+ ס״מ</);
  assert.equal(PileCageEngine.calculate({ ...base, barSpacingDisplayMode: 'clear' }).data.barSpacingDisplayMode, 'clear');
  assert.equal(buildShapeDataContractV2({ ...base, barSpacingDisplayMode: 'clear' }).data.barSpacingDisplayMode, 'clear');
});

test('round pile cage component gallery reuses four canonical visuals and keeps spiral card minimal', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const modal = Object.create(ShapeEditorModal.prototype);
  modal.current = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate', bendOrientationDeg: 0,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 60, noWrap: true }, { name: 'B', length: 300, pitch: 10 }, { name: 'C', length: 840, pitch: 20 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  };
  const html = modal._pileComponentCardsHtml();
  const spiralCard = html.match(/data-pile-component-card="spiral_consolidated"[\s\S]*?<\/article>/)?.[0] || '';

  assert.equal((html.match(/data-pile-component-card=/g) || []).length, 4);
  assert.equal((html.match(/data-engine="PolylineBarEngine"/g) || []).length, 2);
  assert.equal((html.match(/data-engine="SpiralEngine"/g) || []).length, 1);
  assert.equal((html.match(/data-engine="RingEngine"/g) || []).length, 1);
  assert.match(spiralCard, /Ø8 mm/);
  assert.match(spiralCard, /D 48 cm/);
  assert.match(spiralCard, /72 ↻/);
  assert.match(spiralCard, /CUT [\d,.]+ cm/);
  assert.doesNotMatch(spiralCard, /@|פסיעה|L1|L2|L3|NO WRAP|ללא כריכות/);
  assert.match(html, /5 × Ø20 mm/);
  assert.match(html, /1200 \+ 20 cm/);
  assert.match(html, /5 × Ø18 mm/);
});

test('round pile cage hoop component card shows the actual authored quantity', () => {
  const context = loadShapeEditorGeometry();
  const { ShapeEditorModal } = context.window.IronBendShapeGeometry;
  const modal = Object.create(ShapeEditorModal.prototype);
  modal.current = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate', bendOrientationDeg: 0,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 3, hoopStart: 150, hoopSpacing: 300,
  };
  const html = modal._pileComponentCardsHtml();
  const hoopCard = html.match(/data-pile-component-card="hoop_ring"[\s\S]*?<\/article>/)?.[0] || '';

  assert.match(hoopCard, /3 × Ø18 mm/);
  assert.doesNotMatch(hoopCard, /5 × Ø18 mm/);
});

test('round pile cage draws only alternating longitudinal bars with a head bend', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const svg = ShapeEngineRouter.render({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    barPattern: 'alternate', bendLength: 20,
    spiralDiameter: 8, spiralPitch: 15, spiralZones: [{ length: 1180, pitch: 15 }],
    hoopDiameter: 18, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  }, 300, 260);

  assert.equal((svg.match(/class="pile-l-bar"[^>]*data-pile-head-hook="1"/g) || []).length, 0, 'bent bars run straight in elevation — the head bend clutters the side view and is shown only in section');
  assert.equal((svg.match(/class="pile-bent-head-hook"[^>]*data-pile-head-hook="1"/g) || []).length, 5, 'the five head bends are drawn as short legs in section');
  assert.match(svg, /class="pile-l-bar" data-pile-bar-type="bent"[^>]*x1="[^"]+" y1="[^"]+" x2="[^"]+" y2="[^"]+"/);
  assert.match(svg, /data-pile-head="1"/);
  assert.match(svg, /data-pile-alternating-legend="1"/);
  assert.equal((svg.match(/class="pile-hoop"/g) || []).length, 6, 'five side-view rings and one circular cross-section ring remain separate from bent bars');
});

test('round pile cage keeps bend geometry separate from the free assembly orientation', () => {
  const context = loadShapeEditorGeometry();
  const { PileCageEngine, buildShapeDataContractV2 } = context;
  const source = {
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    barPattern: 'alternate',
    bendOrientationDeg: -30.5,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 1200, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  };
  const result = PileCageEngine.calculate(source);
  const bent = result.manufacturingBreakdown.find(part => part.componentType === 'longitudinal_l_bar');
  const contract = buildShapeDataContractV2(source);
  const svg = PileCageEngine.render({ ...source, barPattern: 'alternate' }, 300, 260);

  assert.deepEqual(bent.angles, [90], 'the canonical L-bar bend remains 90 degrees');
  assert.equal(Object.hasOwn(bent, 'bendOrientationDeg'), false, 'assembly orientation must not leak into the L-bar production component');
  assert.equal(result.data.bendOrientationDeg, 329.5);
  assert.equal(result.data.bendOrientationReference, 'radial_inward');
  assert.equal(result.data.bars.filter(bar => bar.type === 'L').every(bar => bar.bendOrientationDeg === 329.5), true);
  assert.equal(contract.data.bendOrientationDeg, 329.5);
  assert.match(svg, /data-bend-orientation-deg="329\.5"/);
  assert.equal((svg.match(/data-pile-bend-orientation="329\.5"/g) || []).length, 5);
});

test('pile bend orientation accepts arbitrary numeric degrees and persists the next-cage default', () => {
  const context = loadShapeEditorGeometry();
  const editorSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');

  assert.equal(context.normalizePileBendOrientationDeg('450.25°'), 90.25);
  assert.equal(context.normalizePileBendOrientationDeg('-30,5'), 329.5);
  assert.equal(context.normalizePileBendOrientationDeg('not-a-number'), null);
  assert.equal(context.savePileBendOrientationDefault('127.75'), true);
  assert.equal(context.loadPileBendOrientationDefault(), 127.75);
  assert.equal(context.localStorage._values.ironbend_pile_bend_orientation_deg_v1, '127.75');
  assert.match(editorSource, /data-pile-field="bendOrientationDeg"/);
  assert.match(editorSource, /type="text" inputmode="decimal"/);
  assert.match(editorSource, /bendOrientationDeg: \['∠','כיוון הכיפוף סביב הכלוב','°','0 פנימה · 90 עם כיוון השעון'\]/);
});

test('round pile cage calculates the continuous spiral from its configured spiral zone', () => {
  const { PileCageEngine } = loadShapeEditorGeometry();
  const result = PileCageEngine.calculate({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48, spiralPitch: 15, spiralZones: [{ length: 1180, pitch: 15 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  });

  const spiral = result.manufacturingBreakdown.find(part => part.componentType === 'spiral_consolidated');
  assert.equal(result.data.spiral.coverageLengthMm, 11800);
  assert.equal(spiral.schedule[0].axialLengthMm, 11800);
  assert.equal(spiral.schedule[0].turns, Number((11800 / 150).toFixed(2)));
});

test('round pile cage calculates every wrapping segment and excludes no-wrap steel', () => {
  const { PileCageEngine } = loadShapeEditorGeometry();
  const result = PileCageEngine.calculate({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [
      { name: 'A', length: 300, pitch: 15 },
      { name: 'B', length: 200, pitch: 15, noWrap: true },
      { name: 'C', length: 700, pitch: 20 },
    ],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  });

  const spiral = result.manufacturingBreakdown.find(part => part.componentType === 'spiral_consolidated');
  assert.deepEqual(spiral.schedule.map(part => part.name), ['A', 'B', 'C']);
  assert.deepEqual(spiral.schedule.map(part => part.noWrap), [false, true, false]);
  assert.equal(result.data.spiralZones[1].noWrap, true);
  assert.equal(result.data.spiralZones[1].pitchMm, null);
  assert.equal(spiral.schedule[1].turns, 0);
  assert.equal(spiral.schedule[1].helicalCutLengthMm, 0);
  assert.equal(spiral.schedule[1].weightKg, 0);
  assert.equal(result.calculated.totalSpiralLengthMm, spiral.totalLengthMm);
  assert.equal(result.calculated.weightKg, Number(result.manufacturingBreakdown.reduce((sum, part) => sum + part.weightKg, 0).toFixed(3)));
  assert.deepEqual(result.productionCards.map(card => card.componentType), ['longitudinal_straight_bar', 'longitudinal_l_bar', 'spiral_consolidated', 'hoop_ring', 'pile_assembly']);
});

test('round pile cage Shape V2 keeps component quantities but never stores order quantity', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'piles', roundPileCage: true, quantity: 9,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    straightBarCount: 5, bentBarCount: 5,
    straightBarLength: 1200, bentBarLength: 1220, bendLength: 20,
    spiralDiameter: 8, spiralOuterDiameter: 48,
    spiralZones: [{ name: 'A', length: 300, pitch: 15 }, { name: 'B', length: 200, noWrap: true }, { name: 'C', length: 700, pitch: 20 }],
    hoopDiameter: 18, hoopOuterDiameter: 42, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  });

  assert.equal('quantity' in contract, false);
  assert.equal('quantity' in contract.data, false);
  assert.equal(contract.data.hoops.quantity, 5);
  assert.deepEqual(contract.calculated.manufacturingBreakdown.map(part => part.quantity), [5, 5, 1, 5]);
  assert.deepEqual(contract.machineOutput.generic.productionCards.map(card => card.quantity), [5, 5, 1, 5, 1]);
});

test('round pile cage drawing leaves a no-wrap segment empty and stays monochrome', () => {
  const { ShapeEngineRouter } = loadShapeEditorGeometry();
  const svg = ShapeEngineRouter.render({
    family: 'piles', roundPileCage: true,
    pileDiameter: 60, pileLength: 1200,
    longitudinalBars: 10, longitudinalDiameter: 20,
    barPattern: 'alternate', bendLength: 20,
    spiralDiameter: 8, spiralPitch: 15,
    spiralZones: [{ name: 'A', length: 300, pitch: 15 }, { name: 'B', length: 200, noWrap: true }, { name: 'C', length: 700, pitch: 20 }],
    hoopDiameter: 18, hoopQuantity: 5, hoopStart: 150, hoopSpacing: 30,
  }, 300, 260);

  assert.match(svg, /class="pile-no-wrap-zone" data-zone="1"/);
  assert.match(svg, /class="pile-no-wrap-label"[\s\S]*?>ללא<\/text><text[^>]*>כריכות<\/text>/);
  assert.doesNotMatch(svg, /textLength=/, 'no-wrap wording must remain readable rather than horizontally distorted');
  assert.doesNotMatch(svg, /#16a34a|#1d4ed8/);
  assert.match(svg, /data-pile-head="1"/);
});


test('buildShapeDataContractV2 returns bars envelope without shape-owned quantity', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'bars',
    presetId: 'u_bar',
    presetName: 'U bar',
    sides: [350, 1200, 350],
    angles: [90, 90],
    diameter: 12,
    quantity: 99,
  });

  assert.equal(contract.contractVersion, 2);
  assert.equal(contract.shapeVersion, 1);
  assert.ok(contract.shapeId);
  assert.equal(contract.shapeType, 'u_bar');
  assert.equal(contract.family, 'bars');
  assert.equal(contract.source, 'shape-editor');
  assert.deepEqual(contract.data, { sides: [350, 1200, 350], angles: [90, 90], diameter: 12 });
  assert.equal(contract.calculated.totalLengthMm, 1900);
  assert.equal(contract.calculated.totalWeightKg, contract.calculated.weightKg);
  assert.equal(contract.calculated.bendCount, 2);
  assert.equal(contract.validation.valid, true);
  assert.equal(contract.machineOutput.generic.family, 'bars');
  assert.equal(contract.machineOutput.generic.weightKg, contract.calculated.weightKg);
  assert.deepEqual(contract.machineOutput.generic.units, { length: 'mm', weight: 'kg', angle: 'deg' });
  assert.equal(contract.machineOutput.generic.segments.length, 3);
  assert.deepEqual(Object.keys(contract.machineOutput.machineProfiles).sort(), ['MEP', 'PEDAX', 'SCHNELL']);
  assert.equal('quantity' in contract, false);
  assert.equal('quantity' in contract.data, false);
  assert.equal('quantity' in contract.machineOutput.generic, false);
  assert.equal(contract.calculation.engine, 'shape-editor');
  assert.equal(contract.calculation.contract, 'SHAPE_DATA_CONTRACT_V2');
});

test('buildShapeDataContractV2 normalizes unstable editor input', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'bars',
    presetId: 'messy_bar',
    shapeVersion: '2.7',
    sides: ['100', 'bad'],
    angles: ['90'],
    diameter: '10',
    qty: 3,
  });

  assert.equal(contract.shapeVersion, 3);
  assert.deepEqual(contract.data.sides, [100, 0]);
  assert.equal('qty' in contract.data, false);
  assert.equal(contract.validation.valid, false);
  assert.match(contract.validation.errors.join(' | '), /sides\[1\] must be greater than 0/);
  assert.equal(contract.machineOutput.generic.totalLengthMm, contract.calculated.totalLengthMm);
});

test('buildShapeDataContractV2 accepts closed bar shapes with a final bend angle', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'bars',
    presetId: 'closed_stirrup',
    sides: [400, 200, 400, 200],
    angles: [90, 90, 90, 90],
    diameter: 8,
  });

  assert.equal(contract.validation.valid, true);
  assert.equal(contract.calculated.bendCount, 4);
  assert.equal(contract.machineOutput.generic.segments[3].bendAfterDeg, 90);
});

test('buildShapeDataContractV2 returns mesh envelope with counts and machine profile placeholders', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'mesh',
    length: 600,
    width: 250,
    longitudinalDiameter: 8,
    longitudinalSpacing: 20,
    transverseDiameter: 8,
    transverseSpacing: 20,
    edgeLeft: 0,
    edgeRight: 0,
    edgeTop: 0,
    edgeBottom: 0,
    quantity: 4,
  });

  assert.equal(contract.shapeType, 'mesh_rectangular');
  assert.equal(contract.family, 'mesh');
  assert.equal(contract.data.length, 600);
  assert.equal(contract.data.width, 250);
  assert.equal(contract.calculated.longitudinalBarCount, 14);
  assert.equal(contract.calculated.transverseBarCount, 31);
  assert.equal(contract.calculated.totalLengthMm, 16150);
  assert.equal(contract.machineOutput.generic.longitudinalBarCount, 14);
  assert.equal(contract.machineOutput.generic.transverseBarCount, 31);
  assert.equal(contract.validation.valid, true);
  assert.equal('quantity' in contract.data, false);
  assert.deepEqual(Object.keys(contract.machineOutput.machineProfiles).sort(), ['MEP', 'PEDAX', 'SCHNELL']);
});

test('buildShapeDataContractV2 returns pile cage envelope with spiral zone machine output', () => {
  const { buildShapeDataContractV2 } = loadShapeEditorGeometry();
  const contract = buildShapeDataContractV2({
    family: 'piles',
    pileDiameter: 70,
    pileLength: 2200,
    longitudinalBars: 26,
    longitudinalDiameter: 22,
    spiralDiameter: 8,
    spiralZones: [
      { length: 70, pitch: 10 },
      { length: 200, pitch: 20 },
      { length: 1350, pitch: 20 },
    ],
    quantity: 2,
  });

  assert.equal(contract.shapeType, 'round_pile_cage');
  assert.equal(contract.family, 'piles');
  assert.equal(contract.data.longitudinalBars, 26);
  assert.equal(contract.data.spiralZones[0].name, 'Zone A');
  assert.equal(contract.calculated.totalLongitudinalLengthMm, 572000);
  assert.ok(contract.calculated.totalSpiralLengthMm > 0);
  assert.ok(contract.calculated.manufacturingBreakdown.length >= 2);
  assert.equal(contract.machineOutput.generic.spiralZones[1].startMm, 700);
  assert.equal(contract.machineOutput.generic.spiralZones[2].pitchMm, 200);
  assert.ok(contract.machineOutput.generic.manufacturingBreakdown.some(part => part.componentType === 'spiral_zone'));
  assert.ok(contract.machineOutput.generic.productionCards.some(card => card.cardType === 'pile_master'));
  assert.ok(contract.machineOutput.generic.productionCards.some(card => card.cardType === 'pile_component'));
  assert.equal(contract.validation.valid, true);
  assert.equal('quantity' in contract.data, false);
  assert.deepEqual(Object.keys(contract.machineOutput.machineProfiles).sort(), ['MEP', 'PEDAX', 'SCHNELL']);
});

test('shape editor approve path returns the SHAPE_DATA_CONTRACT_V2 envelope', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-editor.js'), 'utf8');
  const confirmBlock = editor.match(/_confirm\(\) \{[\s\S]*?this\.close\(\);[\s\S]*?\n  \}/);

  assert.ok(confirmBlock, 'expected _confirm block');
  assert.match(confirmBlock[0], /delete normalized\.quantity/);
  assert.match(confirmBlock[0], /delete normalized\.qty/);
  assert.match(confirmBlock[0], /const contract = buildShapeDataContractV2\(normalized\)/);
  assert.match(confirmBlock[0], /\.\.\.contract/);
});



test('production card renders real spiral items from item fields instead of straight fallback', () => {
  const svg = itemShapeSvg({
    shape_name: 'spiral',
    spiral_diameter_mm: 300,
    spiral_turns: 30,
  });

  assert.match(svg, /data-shape-kind="spiral"/);
  assert.match(svg, /data-spiral-diameter-mm="300"/);
  assert.match(svg, /data-spiral-turns="30"/);
  assert.match(svg, /data-scale-mode="container-fit"/);
  assert.doesNotMatch(svg, /max-height:/);
  assert.match(svg, /data-spiral-visual-labels="1"/);
  assert.match(svg, /data-spiral-turn-count="1"/);
  assert.match(svg, />N=30</);
  assert.match(svg, /\u05e7\u05d5\u05d8\u05e8 \u05e1\u05e4\u05d9\u05e8\u05d0\u05dc\u05d4/);
  assert.match(svg, />N</);
  assert.doesNotMatch(svg, /data-shape-kind="straight-bar"/);
  assert.doesNotMatch(svg, /30 turns/);
});

test('production card renders legacy spiral snapshot retroactively', () => {
  const svg = itemShapeSvg({
    shape_snapshot_json: JSON.stringify({
      contract: 'ORDER_ITEM_SHAPE_SNAPSHOT',
      shapeName: 'ספיראלה',
      spiralDiameterMm: 250,
      spiralTurns: 18,
      segments: [],
    }),
    segments: JSON.stringify([]),
  });

  assert.match(svg, /data-shape-kind="spiral"/);
  assert.match(svg, /data-spiral-diameter-mm="250"/);
  assert.match(svg, /data-spiral-turns="18"/);
  assert.match(svg, />N=18</);
  assert.doesNotMatch(svg, /18 turns/);
});

test('production card renders a single straight bar with readable centimeter dimension', () => {
  const svg = shapeSvg(JSON.stringify([
    { length_mm: 850, angle_deg: 0 },
  ]));

  assert.match(svg, /data-shape-kind="straight-bar"/);
  assert.match(svg, />85</);
  assert.match(svg, /stroke="#1a2332"/);
  assert.doesNotMatch(svg, /stroke="#ccc"/);
});

test('production card renders open U bars as a readable U shape, not a flattened line', () => {
  const svg = shapeSvg(JSON.stringify([
    { length_mm: 200, angle_deg: 90 },
    { length_mm: 1900, angle_deg: 90 },
    { length_mm: 200, angle_deg: 0 },
  ]));

  assert.match(svg, /data-shape-kind="open-u"/);
  const pathMatch = svg.match(/<path d="M ([^"]+)"/);
  assert.ok(pathMatch, 'expected a drawn open U path');
  const points = pathMatch[1].split(' L ').map(pair => pair.split(',').map(Number));
  assert.equal(points.length, 4, 'expected open U to have two legs and one bridge');
  const uniqueY = new Set(points.map(point => point[1]));
  assert.ok(uniqueY.size > 1, 'expected open U to have real vertical span');
  assert.ok(Math.abs(points[1][1] - points[0][1]) > 20, 'expected first leg to remain visible');
  assert.ok(Math.abs(points[3][1] - points[2][1]) > 20, 'expected second leg to remain visible');
  assert.equal(points[1][1], points[2][1], 'expected the bridge to be horizontal');
  assert.ok(points[1][1] > points[0][1], 'expected the long bridge to render as the bottom base');
  assert.match(svg, />190</);
  assert.match(svg, />20</);
  assert.doesNotMatch(svg, /stroke="#a8b0ba"/, '90 is the default bend and is not marked on bars');
  assert.match(svg, /<line x1="42\.0" y1="51\.0" x2="20\.0" y2="51\.0"/);
  assert.match(svg, /<line x1="110\.0" y1="78\.0" x2="110\.0" y2="98\.0"/);
  assert.match(svg, /<line x1="178\.0" y1="51\.0" x2="200\.0" y2="51\.0"/);
  assert.match(svg, /90/);
  assert.doesNotMatch(svg, /90&#176;/);
  assert.doesNotMatch(svg, /<circle/);
});

test('production card keeps short bent legs visually readable next to a long bar', () => {
  const svg = shapeSvg(JSON.stringify([
    { length_mm: 75, angle_deg: 90 },
    { length_mm: 2500, angle_deg: 90 },
    { length_mm: 300, angle_deg: 0 },
  ]));
  const pathMatch = svg.match(/<path d="M ([^"]+)"/);
  assert.ok(pathMatch, 'expected a drawn production-card path');
  const points = pathMatch[1].split(' L ').map(pair => pair.split(',').map(Number));
  const firstSegmentLength = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);

  assert.match(svg, /data-proportional-short-bends="1"/);
  assert.ok(firstSegmentLength >= 18, `expected short bent leg to remain readable, got ${firstSegmentLength}`);
  assert.match(svg, />7.5</);
});

test('production card renders closed stirrups as a closed rectangular hoop', () => {
  const svg = shapeSvg(JSON.stringify([
    { length_mm: 100, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 90 },
    { length_mm: 100, angle_deg: 0 },
  ]));

  assert.match(svg, /data-shape-kind="closed-stirrup"/);
  assert.match(svg, /Z/);
  assert.match(svg, />30</);
  assert.match(svg, />95</);
  assert.match(svg, /stroke="#a8b0ba"/);
  assert.match(svg, /data-stirrup-marker="overlap"/);
  assert.doesNotMatch(svg, /data-tail=/);
  assert.doesNotMatch(svg, /end tails/);
  assert.doesNotMatch(svg, /<circle/);
});

test('production card accepts closed stirrup OCR with one visible overlap tail', () => {
  const svg = shapeSvg(JSON.stringify([
    { length_mm: 100, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 0 },
  ]));

  assert.match(svg, /data-shape-kind="closed-stirrup"/);
  assert.match(svg, />30</);
  assert.match(svg, />95</);
  assert.match(svg, /stroke="#a8b0ba"/);
  assert.match(svg, /data-stirrup-marker="overlap"/);
  assert.doesNotMatch(svg, /data-tail=/);
  assert.doesNotMatch(svg, /end tails/);
  assert.doesNotMatch(svg, /<circle/);
});

test('orders detail shape renderer has a dedicated closed-stirrup path', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'shape-renderer.js'), 'utf8');

  assert.match(renderer, /function closedStirrupParts/);
  assert.match(renderer, /data-shape-kind', 'closed-stirrup'/);
  assert.match(renderer, /renderClosedStirrup2D/);
});

test('orders detail normalizes legacy OCR segment order before drawing', () => {
  const orders = fs.readFileSync(path.join(__dirname, '..', 'public', 'orders.html'), 'utf8');

  assert.match(orders, /function normalizeDisplaySegments/);
  assert.match(orders, /צורת ח\|צורת u\|פתוח\|פתוחה/);
  assert.match(orders, /חישוק\|חפיפה\|מסגרת/);
});

test('single segment geometry cannot be normalized as a spiral or ring', () => {
  const segments = [{ length_mm: 25, angle_deg: 0 }];

  assert.equal(normalizeFactoryShapeName('טבעת/ספירלה', segments), 'straight bar');
  assert.equal(normalizeFactoryShapeName('spiral ring', segments), 'straight bar');
});

test('real spiral geometry uses diameter and turns instead of side segments', () => {
  assert.equal(normalizeFactoryShapeName('spiral', [], {
    spiral_diameter_mm: 50,
    spiral_turns: 160,
  }), 'spiral');
  assert.equal(spiralCutLengthMm(50, 160), Math.round(Math.PI * 50 * 160));
});

test('Hebrew open U names normalize side order by physical bending path', () => {
  const segments = normalizeFactorySegments('צורת ח פתוחה', [
    { length_mm: 550, angle_deg: 90 },
    { length_mm: 250, angle_deg: 90 },
    { length_mm: 250, angle_deg: 0 },
  ]);

  assert.deepEqual(segments.map(segment => segment.length_mm), [250, 550, 250]);
  assert.equal(normalizeFactoryShapeName('צורת ח פתוחה', segments), 'open U-shaped bar');
});

test('Hebrew closed stirrup names normalize as closed overlap hoops', () => {
  const segments = normalizeFactorySegments('חישוק', [
    { length_mm: 100, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 90 },
    { length_mm: 950, angle_deg: 90 },
    { length_mm: 300, angle_deg: 90 },
    { length_mm: 100, angle_deg: 0 },
  ]);

  assert.deepEqual(segments.map(segment => segment.length_mm), [100, 950, 300, 950, 300, 100]);
  assert.equal(normalizeFactoryShapeName('חישוק', segments), 'closed stirrup 90-degree overlap');
});

test('reported length surplus is assigned to the two physical end legs', () => {
  const result = distributeSurplusToEndSegments([
    { length_mm: 450, angle_deg: 90 },
    { length_mm: 2400, angle_deg: 90 },
    { length_mm: 450, angle_deg: 0 },
  ], 4200);

  assert.equal(result.adjusted, true);
  assert.equal(result.surplus, 900);
  assert.equal(result.perEnd, 450);
  assert.deepEqual(result.segments.map(segment => segment.length_mm), [900, 2400, 900]);
  assert.equal(result.totalLength, 4200);
});

