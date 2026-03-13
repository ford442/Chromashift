# Chromashift Rendering Fix Plan

## Problem Statement
Current rendering is broken — only showing a thin colored line preview instead of full-screen crop circle visualization like cr0p.1ink.us.

## Root Cause Analysis
1. **Canvas size mismatch** — WebGPU canvases require explicit `width`/`height` HTML attributes, not just CSS
2. **Viewport configuration** — Full-screen quad vertex shader assumes canvas size matches actual dimensions
3. **Potential texture binding issues** — UV mapping or sampler state

## Fix Priority

### Phase 1: Canvas Sizing (CRITICAL) ✅ DONE
- [x] Add dynamic `width`/`height` attributes to `<canvas>` element
- [x] Implement resize observer to sync canvas size with container
- [x] Verify WebGPU context is properly configured with correct dimensions
- [x] Test: Canvas should fill entire viewport
- **Commit:** 58bb27e "Fix WebGPU canvas sizing for full-screen rendering"

### Phase 2: Validate Rendering Pipeline (IN PROGRESS)
- [ ] Verify full-screen quad vertex positions are correct
- [ ] Check texture is loading (use debug output or DevTools texture inspection)
- [ ] Validate UV coordinate mapping (should be [0,1] for full texture)
- [ ] **VISUAL TEST REQUIRED:** Open http://localhost:5173 after `npm run dev`
  - Should see full crop circle image filling viewport
  - Not just a thin colored line
  - All three color layers (red/orange, violet/blue, green/yellow) visible
- [ ] Check if rotation is clipping geometry (may need UV rotation fix)

### Phase 3: Performance & Visual Correctness
- [ ] Verify three-layer blending order (layers 0, 1, 2)
- [ ] Check blend mode: `src-alpha / one-minus-src-alpha` produces correct compositing
- [ ] Validate luminance threshold ranges match cr0p.1ink.us behavior
- [ ] Test with multiple images to ensure consistency

### Phase 4: Wolfram MCP Integration (Post-fix)
Once rendering is correct, proceed with AI analysis + threshold optimization

## Success Criteria
✅ Canvas fills entire viewport
✅ Crop circle image visible with proper color separation
✅ All three color layers (red/orange, violet/blue, green/yellow) rendering
✅ Rotation controls affect layers independently
✅ Performance: 30+ fps on modern GPU

## Next Steps
1. Fix canvas sizing in `App.tsx`
2. Test with `npm run dev`
3. Verify rendering matches reference app
4. Commit fix to feature branch
