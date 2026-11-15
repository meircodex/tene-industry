const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('report durations carry rounded minutes into the next hour and distinguish seconds from zero',()=>{
 const html=fs.readFileSync('public/reports-unified.js','utf8');
 const context={num:v=>Number(v)||0};vm.runInNewContext(html.match(/function formatMinutes\(value\) \{[\s\S]*?\n\}/)[0],context);
 assert.match(context.formatMinutes(59.999),/^1 /);assert.match(context.formatMinutes(119.999),/^2 /);
 assert.match(context.formatMinutes(0.3),/^18 /);assert.notEqual(context.formatMinutes(0.3),context.formatMinutes(0));
});
