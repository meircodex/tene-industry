'use strict';
importScripts('/straight-stock-cutting.js?v=2');
self.onmessage=event=>{
  try{self.postMessage({plan:self.IronBendStraightStock.planInventoryCutting(event.data)});}
  catch(error){self.postMessage({error:error.message||'חישוב תוכנית החיתוך נכשל'});}
};
