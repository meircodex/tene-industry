const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function scannerHarness(acquire,detect){
 const video={srcObject:null,play:async()=>{}},shell={classList:{add(){},remove(){}}},els={camera:video,cameraShell:shell,stopCamera:{hidden:true},startCamera:{hidden:false}},codes=[],errors=[];
 const Detector=class{detect(){return detect();}};
 const context={window:{BarcodeDetector:Detector,addEventListener(){}},BarcodeDetector:Detector,navigator:{mediaDevices:{getUserMedia:acquire}},document:{hidden:false,getElementById:id=>els[id],addEventListener(){}},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync('public/worker-portal-scanner.js','utf8'),context);
 return{scanner:context.window.createWorkerPortalScanner({onCode:code=>codes.push(code),onError:()=>errors.push(true)}),codes,errors,video};
}
test('a QR frame closes the camera tracks and passes the scanned code once',async()=>{
 let stops=0;const stream={getTracks:()=>[{stop(){stops++;}}]},h=scannerHarness(async()=>stream,async()=>[{rawValue:'ORDER-1917'}]);
 await h.scanner.start();await new Promise(setImmediate);assert.deepEqual(h.codes,['ORDER-1917']);assert.equal(stops,1);assert.equal(h.video.srcObject,null);
});
test('leaving scan view while permission is pending closes a late camera without opening a card',async()=>{
 let resolve,stops=0;const h=scannerHarness(()=>new Promise(r=>resolve=r),async()=>[{rawValue:'ORDER-1917'}]);
 const running=h.scanner.start();h.scanner.stop();resolve({getTracks:()=>[{stop(){stops++;}}]});await running;
 assert.equal(stops,1);assert.deepEqual(h.codes,[]);assert.deepEqual(h.errors,[]);
});
test('a decoded frame arriving after scan cancellation is ignored',async()=>{
 let resolve;const h=scannerHarness(async()=>({getTracks:()=>[{stop(){}}]}),()=>new Promise(r=>resolve=r));
 await h.scanner.start();h.scanner.stop();resolve([{rawValue:'ORDER-1917'}]);await new Promise(setImmediate);assert.deepEqual(h.codes,[]);
});
