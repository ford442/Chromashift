
var ChromashiftEngine = (() => {
  var _scriptName = import.meta.url;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var a=moduleArg,f,h,k=new Promise((b,c)=>{f=b;h=c}),l="object"==typeof window,m="function"==typeof importScripts,n=Object.assign({},a),p="",q,t;
if(l||m)m?p=self.location.href:"undefined"!=typeof document&&document.currentScript&&(p=document.currentScript.src),_scriptName&&(p=_scriptName),p.startsWith("blob:")?p="":p=p.substr(0,p.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(t=b=>{var c=new XMLHttpRequest;c.open("GET",b,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),q=b=>fetch(b,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var u=a.printErr||console.error.bind(console);
Object.assign(a,n);n=null;var v;a.wasmBinary&&(v=a.wasmBinary);var w,x=!1,y;function z(){var b=w.buffer;a.HEAP8=new Int8Array(b);a.HEAP16=new Int16Array(b);a.HEAPU8=y=new Uint8Array(b);a.HEAPU16=new Uint16Array(b);a.HEAP32=new Int32Array(b);a.HEAPU32=new Uint32Array(b);a.HEAPF32=new Float32Array(b);a.HEAPF64=new Float64Array(b)}var A=[],B=[],C=[];function D(){var b=a.preRun.shift();A.unshift(b)}var E=0,F=null,G=null,H=b=>b.startsWith("data:application/octet-stream;base64,"),I;
function J(b){if(b==I&&v)return new Uint8Array(v);if(t)return t(b);throw"both async and sync fetching of the wasm failed";}function K(b){return v?Promise.resolve().then(()=>J(b)):q(b).then(c=>new Uint8Array(c),()=>J(b))}function M(b,c,d){return K(b).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{u(`failed to asynchronously prepare wasm: ${e}`);a.onAbort?.(e);e="Aborted("+e+")";u(e);x=!0;e=new WebAssembly.RuntimeError(e+". Build with -sASSERTIONS for more info.");h(e);throw e;})}
function N(b,c){var d=I;return v||"function"!=typeof WebAssembly.instantiateStreaming||H(d)||"function"!=typeof fetch?M(d,b,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,b).then(c,function(g){u(`wasm streaming compile failed: ${g}`);u("falling back to ArrayBuffer instantiation");return M(d,b,c)}))}
var O=b=>{for(;0<b.length;)b.shift()(a)},P={a:b=>{var c=y.length;b>>>=0;if(2147483648<b)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,b+100663296);var g=Math;e=Math.max(b,e);a:{g=(g.min.call(g,2147483648,e+(65536-e%65536)%65536)-w.buffer.byteLength+65535)/65536;try{w.grow(g);z();var r=1;break a}catch(L){}r=void 0}if(r)return!0}return!1}},Q=function(){function b(d){Q=d.exports;w=Q.b;z();B.unshift(Q.c);E--;a.monitorRunDependencies?.(E);0==E&&(null!==F&&(clearInterval(F),F=null),G&&(d=
G,G=null,d()));return Q}var c={a:P};E++;a.monitorRunDependencies?.(E);if(a.instantiateWasm)try{return a.instantiateWasm(c,b)}catch(d){u(`Module.instantiateWasm callback failed with error: ${d}`),h(d)}I||=a.locateFile?H("chromashift_engine.wasm")?"chromashift_engine.wasm":a.locateFile?a.locateFile("chromashift_engine.wasm",p):p+"chromashift_engine.wasm":(new URL("chromashift_engine.wasm",import.meta.url)).href;N(c,function(d){b(d.instance)}).catch(h);return{}}();
a._computeAverageLuminance=(b,c)=>(a._computeAverageLuminance=Q.d)(b,c);a._computeAverageLuminanceStrided=(b,c,d,e)=>(a._computeAverageLuminanceStrided=Q.e)(b,c,d,e);a._classifyPixel=(b,c,d,e)=>(a._classifyPixel=Q.f)(b,c,d,e);a._buildBandLut=(b,c)=>(a._buildBandLut=Q.g)(b,c);a._classifyPixelLut=(b,c,d,e,g)=>(a._classifyPixelLut=Q.h)(b,c,d,e,g);a._classifyPixelsBulk=(b,c,d,e)=>(a._classifyPixelsBulk=Q.i)(b,c,d,e);a._classifyPixelsBulkLut=(b,c,d,e)=>(a._classifyPixelsBulkLut=Q.j)(b,c,d,e);
a._computeClassificationMask=(b,c,d,e,g)=>(a._computeClassificationMask=Q.k)(b,c,d,e,g);a._computeClassificationMaskLut=(b,c,d,e,g)=>(a._computeClassificationMaskLut=Q.l)(b,c,d,e,g);a._computeLuminanceHistogram=(b,c,d)=>(a._computeLuminanceHistogram=Q.m)(b,c,d);a._computeColorBandCounts=(b,c,d,e)=>(a._computeColorBandCounts=Q.n)(b,c,d,e);a._buildRotationMat3=(b,c)=>(a._buildRotationMat3=Q.o)(b,c);a._durationToDecay=(b,c)=>(a._durationToDecay=Q.p)(b,c);
a._advanceLayerAngles=(b,c,d,e)=>(a._advanceLayerAngles=Q.q)(b,c,d,e);a._advanceLayerAngles3=(b,c,d,e,g,r,L)=>(a._advanceLayerAngles3=Q.r)(b,c,d,e,g,r,L);a._simulateTracerDecay=(b,c,d)=>(a._simulateTracerDecay=Q.s)(b,c,d);a._computeMotionFlow=(b,c,d,e,g)=>(a._computeMotionFlow=Q.t)(b,c,d,e,g);a._malloc=b=>(a._malloc=Q.u)(b);a._free=b=>(a._free=Q.v)(b);var R;G=function S(){R||T();R||(G=S)};
function T(){function b(){if(!R&&(R=!0,a.calledRun=!0,!x)){O(B);f(a);a.onRuntimeInitialized?.();if(a.postRun)for("function"==typeof a.postRun&&(a.postRun=[a.postRun]);a.postRun.length;){var c=a.postRun.shift();C.unshift(c)}O(C)}}if(!(0<E)){if(a.preRun)for("function"==typeof a.preRun&&(a.preRun=[a.preRun]);a.preRun.length;)D();O(A);0<E||(a.setStatus?(a.setStatus("Running..."),setTimeout(function(){setTimeout(function(){a.setStatus("")},1);b()},1)):b())}}
if(a.preInit)for("function"==typeof a.preInit&&(a.preInit=[a.preInit]);0<a.preInit.length;)a.preInit.pop()();T();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default ChromashiftEngine;
