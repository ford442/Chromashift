const fs = require('fs');

let code = fs.readFileSync('src/engine/WebGPURenderer.ts', 'utf8');

// 1. Fix sampleCount for layerTextures
code = code.replace(/sampleCount: this\.sampleCount,(\s+\]\)\);)/, 'sampleCount: 1,$1');

// 2. Fix the final compositor pass (it doesn't need MSAA resolver)
code = code.replace(
  /const finalPass = enc\.beginRenderPass\(\{\s+colorAttachments: \[\{\s+view\s*: this\.sampleCount > 1 && this\.msaaTexture \? this\.msaaTexture\.createView\(\) : canvasTex\.createView\(\),\s+resolveTarget: this\.sampleCount > 1 \? canvasTex\.createView\(\) : undefined,\s+loadOp\s*: 'clear',\s+storeOp\s*: this\.sampleCount > 1 \? 'discard' : 'store',/g,
  `const finalPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : canvasTex.createView(),
        loadOp    : 'clear',
        storeOp   : 'store',`
);

fs.writeFileSync('src/engine/WebGPURenderer.ts', code);
