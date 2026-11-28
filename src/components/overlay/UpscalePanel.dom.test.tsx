import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UpscalePanel } from './UpscalePanel';
import type { UpscalePanelProps } from './types';

const noop = () => {};

const IDLE: UpscalePanelProps = {
  upscaleModel: 'realesrgan:general_plus',
  upscaleBusy: false,
  upscaleProgress: 0,
  upscaleInfo: '',
  upscaleError: '',
  onUpscaleModelChange: noop,
  onUpscaleSource: () => Promise.resolve(),
  onUpscaleOutput: () => Promise.resolve(),
};

describe('UpscalePanel outcome', () => {
  it('shows nothing before any job has run', () => {
    render(<UpscalePanel {...IDLE} />);
    expect(screen.queryByTestId('upscale-error')).toBeNull();
    expect(screen.queryByTestId('upscale-status')).toBeNull();
  });

  it('keeps a failure on screen once the busy bar is gone (#269)', () => {
    render(<UpscalePanel {...IDLE} upscaleError="r._OrtGetInputOutputMetadata is not a function" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Upscale failed');
    expect(alert.textContent).toContain('_OrtGetInputOutputMetadata');
    expect(screen.queryByTestId('upscale-progress')).toBeNull();
  });

  it('shows progress, not the stale error, while a job runs', () => {
    render(<UpscalePanel {...IDLE} upscaleBusy upscaleProgress={40} upscaleInfo="Tile 2/5" upscaleError="old" />);
    expect(screen.getByTestId('upscale-progress').textContent).toContain('Tile 2/5');
    expect(screen.queryByTestId('upscale-error')).toBeNull();
  });

  it('reports a finished job', () => {
    render(<UpscalePanel {...IDLE} upscaleInfo="Done — 96×96" />);
    expect(screen.getByRole('status').textContent).toBe('Done — 96×96');
  });
});
