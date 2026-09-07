import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const p = await import(pathToFileURL(process.argv[2]).href);
const choices = [{value:10,name:'Alpha',description:'first description'},{value:20,name:'Beta',description:'second description'}];
const id = process.env.ARASHI_PROMPT_CASE;
let result, expected;
switch(id) {
case 'select': case 'default-select': result=await p.select('Choose item',choices); expected=id==='select'?20:10;break;
case 'multi': result=await p.multiSelect('Choose items',choices); expected=[10,20];break;
case 'input': case 'default-input': result=await p.input('Enter text',id==='default-input'?'fallback':undefined);expected=id==='input'?'jké':'fallback';break;
case 'confirm': case 'yes':result=await p.confirm('Proceed',id==='confirm'?false:undefined);expected=id==='yes';break;
case 'cancel':result=await p.input('Enter text');assert.deepEqual(result,{status:'cancelled',reason:'exit'});break;
default:throw Error(id);
}
if(id!=='cancel') assert.deepEqual(result,{status:'ok',value:expected});
assert.ok(!process.stdin.isRaw);
console.log('PROMPT_RESULT_OK');
assert.deepEqual(await p.input('Reuse terminal'),{status:'ok',value:'reuse'});
assert.ok(!process.stdin.isRaw);
console.log('REUSE_OK');
