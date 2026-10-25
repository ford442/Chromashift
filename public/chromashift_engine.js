
var ChromashiftEngine = (() => {
  var _scriptName = import.meta.url;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var a=moduleArg,f,h,k=new Promise((b,c)=>{f=b;h=c}),l="object"==typeof window,m="function"==typeof importScripts,n=Object.assign({},a),p="",q,r;
if(l||m)m?p=self.location.href:"undefined"!=typeof document&&document.currentScript&&(p=document.currentScript.src),_scriptName&&(p=_scriptName),p.startsWith("blob:")?p="":p=p.substr(0,p.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(r=b=>{var c=new XMLHttpRequest;c.open("GET",b,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),q=b=>fetch(b,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var t=a.printErr||console.error.bind(console);
Object.assign(a,n);n=null;var u;a.wasmBinary&&(u=a.wasmBinary);var v,w=!1,x;function y(){var b=v.buffer;a.HEAP8=new Int8Array(b);a.HEAP16=new Int16Array(b);a.HEAPU8=x=new Uint8Array(b);a.HEAPU16=new Uint16Array(b);a.HEAP32=new Int32Array(b);a.HEAPU32=new Uint32Array(b);a.HEAPF32=new Float32Array(b);a.HEAPF64=new Float64Array(b)}var z=[],A=[],B=[];function C(){var b=a.preRun.shift();z.unshift(b)}var D=0,E=null,F=null,G=b=>b.startsWith("data:application/octet-stream;base64,"),H;
function I(b){if(b==H&&u)return new Uint8Array(u);if(r)return r(b);throw"both async and sync fetching of the wasm failed";}function J(b){return u?Promise.resolve().then(()=>I(b)):q(b).then(c=>new Uint8Array(c),()=>I(b))}function L(b,c,d){return J(b).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{t(`failed to asynchronously prepare wasm: ${e}`);a.onAbort?.(e);e="Aborted("+e+")";t(e);w=!0;e=new WebAssembly.RuntimeError(e+". Build with -sASSERTIONS for more info.");h(e);throw e;})}
function M(b,c){var d=H;return u||"function"!=typeof WebAssembly.instantiateStreaming||G(d)||"function"!=typeof fetch?L(d,b,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,b).then(c,function(g){t(`wasm streaming compile failed: ${g}`);t("falling back to ArrayBuffer instantiation");return L(d,b,c)}))}
var N=b=>{for(;0<b.length;)b.shift()(a)},O={a:b=>{var c=x.length;b>>>=0;if(2147483648<b)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,b+100663296);var g=Math;e=Math.max(b,e);a:{g=(g.min.call(g,2147483648,e+(65536-e%65536)%65536)-v.buffer.byteLength+65535)/65536;try{v.grow(g);y();var K=1;break a}catch(T){}K=void 0}if(K)return!0}return!1}},P=function(){function b(d){P=d.exports;v=P.b;y();A.unshift(P.c);D--;a.monitorRunDependencies?.(D);0==D&&(null!==E&&(clearInterval(E),E=null),F&&(d=
F,F=null,d()));return P}var c={a:O};D++;a.monitorRunDependencies?.(D);if(a.instantiateWasm)try{return a.instantiateWasm(c,b)}catch(d){t(`Module.instantiateWasm callback failed with error: ${d}`),h(d)}H||=a.locateFile?G("chromashift_engine.wasm")?"chromashift_engine.wasm":a.locateFile?a.locateFile("chromashift_engine.wasm",p):p+"chromashift_engine.wasm":(new URL("chromashift_engine.wasm",import.meta.url)).href;M(c,function(d){b(d.instance)}).catch(h);return{}}();
a._computeAverageLuminance=(b,c)=>(a._computeAverageLuminance=P.d)(b,c);a._computeAverageLuminanceStrided=(b,c,d,e)=>(a._computeAverageLuminanceStrided=P.e)(b,c,d,e);a._classifyPixel=(b,c,d,e)=>(a._classifyPixel=P.f)(b,c,d,e);a._buildBandLut=(b,c)=>(a._buildBandLut=P.g)(b,c);a._classifyPixelLut=(b,c,d,e,g)=>(a._classifyPixelLut=P.h)(b,c,d,e,g);a._classifyPixelsBulk=(b,c,d,e)=>(a._classifyPixelsBulk=P.i)(b,c,d,e);a._classifyPixelsBulkLut=(b,c,d,e)=>(a._classifyPixelsBulkLut=P.j)(b,c,d,e);
a._computeClassificationMask=(b,c,d,e,g)=>(a._computeClassificationMask=P.k)(b,c,d,e,g);a._computeClassificationMaskLut=(b,c,d,e,g)=>(a._computeClassificationMaskLut=P.l)(b,c,d,e,g);a._computeLuminanceHistogram=(b,c,d)=>(a._computeLuminanceHistogram=P.m)(b,c,d);a._computeColorBandCounts=(b,c,d,e)=>(a._computeColorBandCounts=P.n)(b,c,d,e);a._buildRotationMat3=(b,c)=>(a._buildRotationMat3=P.o)(b,c);a._durationToDecay=(b,c)=>(a._durationToDecay=P.p)(b,c);
a._advanceLayerAngles=(b,c,d,e)=>(a._advanceLayerAngles=P.q)(b,c,d,e);a._simulateTracerDecay=(b,c,d)=>(a._simulateTracerDecay=P.r)(b,c,d);a._computeMotionFlow=(b,c,d,e,g)=>(a._computeMotionFlow=P.s)(b,c,d,e,g);a._free=b=>(a._free=P.t)(b);a._malloc=b=>(a._malloc=P.u)(b);var Q;F=function R(){Q||S();Q||(F=R)};
function S(){function b(){if(!Q&&(Q=!0,a.calledRun=!0,!w)){N(A);f(a);a.onRuntimeInitialized?.();if(a.postRun)for("function"==typeof a.postRun&&(a.postRun=[a.postRun]);a.postRun.length;){var c=a.postRun.shift();B.unshift(c)}N(B)}}if(!(0<D)){if(a.preRun)for("function"==typeof a.preRun&&(a.preRun=[a.preRun]);a.preRun.length;)C();N(z);0<D||(a.setStatus?(a.setStatus("Running..."),setTimeout(function(){setTimeout(function(){a.setStatus("")},1);b()},1)):b())}}
if(a.preInit)for("function"==typeof a.preInit&&(a.preInit=[a.preInit]);0<a.preInit.length;)a.preInit.pop()();S();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default ChromashiftEngine;
