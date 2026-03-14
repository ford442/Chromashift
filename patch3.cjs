const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// We need to add a ref `hasUpdatedPreviewsForImage = useRef(false)`
code = code.replace(
  /const previewTracerRef = useRef<HTMLCanvasElement>\(null\);/,
  `const previewTracerRef = useRef<HTMLCanvasElement>(null);
  const hasUpdatedPreviewsForImage = useRef(false);`
);

// We need to set it to false when the image changes
code = code.replace(
  /setCurrentImageIndex\(\(prev\) => \(prev \+ 1\) % imageList\.length\);/g,
  `setCurrentImageIndex((prev) => {
        hasUpdatedPreviewsForImage.current = false;
        return (prev + 1) % imageList.length;
      });`
);

code = code.replace(
  /onClick=\{\(\) => setCurrentImageIndex\(idx\)\}/g,
  `onClick={() => { hasUpdatedPreviewsForImage.current = false; setCurrentImageIndex(idx); }}`
);

// We need to wrap the preview updating block in a condition
code = code.replace(
  /\/\/ Update preview: copy main canvas to separated preview\s+const previewSep = previewSeparatedRef\.current;[\s\S]+?\/\/ Update preview: copy main canvas to tracer preview \(it's the same as separated, just labeled differently\)\s+const previewTracer = previewTracerRef\.current;\s+if \(previewTracer && canvasRef\.current\) \{\s+const ctx = previewTracer\.getContext\('2d'\);\s+if \(ctx\) \{\s+ctx\.drawImage\(canvasRef\.current, 0, 0, previewTracer\.width, previewTracer\.height\);\s+\}\s+\}/,
  `// Update preview only on the first frame of a new image
        if (!hasUpdatedPreviewsForImage.current) {
          // Update preview: copy main canvas to separated preview
          const previewSep = previewSeparatedRef.current;
          if (previewSep && canvasRef.current) {
            const ctx = previewSep.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvasRef.current, 0, 0, previewSep.width, previewSep.height);
            }
          }

          // Update preview: copy main canvas to tracer preview
          const previewTracer = previewTracerRef.current;
          if (previewTracer && canvasRef.current) {
            const ctx = previewTracer.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvasRef.current, 0, 0, previewTracer.width, previewTracer.height);
            }
          }

          hasUpdatedPreviewsForImage.current = true;
        }`
);

fs.writeFileSync('src/App.tsx', code);
