import { useMemo, useRef } from 'react';
import type { FrameClock } from '../../engine/frame/FrameClock';
import { RenderHost, type RenderHostOptions } from '../../engine/render/RenderHost';
import type { GpuRefs } from './types';

/**
 * `clock`: the page's frame clock — an in-process renderer's loop runs on it.
 * `hostOptions`: for tests (a forced transport, fake service deps).
 */
export function useGpuRefs(clock: FrameClock, hostOptions?: Omit<RenderHostOptions, 'clock'>): GpuRefs {
  // One host for the app's lifetime: it chooses the transport once, and a
  // canvas it handed to the render worker cannot be handed over again.
  const renderHostRef = useRef<RenderHost | null>(null);
  renderHostRef.current ??= new RenderHost({ ...hostOptions, clock });
  const upscalerRef = useRef<import('../../engine/upscale/Upscaler').Upscaler | null>(null);

  return useMemo(() => ({
    renderHostRef: renderHostRef as GpuRefs['renderHostRef'],
    upscalerRef,
  }), [renderHostRef, upscalerRef]);
}
