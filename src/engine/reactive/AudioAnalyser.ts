import { extractEnergy, extractFrequencyBands } from './modulation';
import type { AudioLevelSnapshot } from './types';

const FFT_SIZE = 2048;
const SMOOTHING = 0.75;

/**
 * Zero-dependency Web Audio analyser wrapper (mic input).
 * Caller must invoke {@link stop} when done to release the microphone.
 */
export class AudioAnalyser {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private freqBuf: Uint8Array<ArrayBuffer> | null = null;
  private timeBuf: Uint8Array<ArrayBuffer> | null = null;

  get isActive(): boolean {
    return this.stream !== null;
  }

  async startMic(): Promise<void> {
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    this.context = context;
    this.analyser = analyser;
    this.source = source;
    this.stream = stream;
    this.freqBuf = new Uint8Array(analyser.frequencyBinCount);
    this.timeBuf = new Uint8Array(analyser.fftSize);

    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  async stop(): Promise<void> {
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.freqBuf = null;
    this.timeBuf = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  /** Read current band levels; returns zeroes when inactive. */
  sample(): AudioLevelSnapshot {
    if (!this.analyser || !this.freqBuf || !this.timeBuf) {
      return { bass: 0, mid: 0, high: 0, energy: 0 };
    }
    this.analyser.getByteFrequencyData(this.freqBuf);
    this.analyser.getByteTimeDomainData(this.timeBuf);
    const bands = extractFrequencyBands(this.freqBuf);
    const energy = extractEnergy(this.timeBuf);
    return { ...bands, energy };
  }
}
