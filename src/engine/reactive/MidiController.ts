import type { MidiBinding, MidiParamId } from './types';

export type MidiCcHandler = (
  channel: number,
  controller: number,
  value: number,
) => void;

/**
 * Thin Web MIDI API wrapper — no external libraries.
 */
export class MidiController {
  private access: MIDIAccess | null = null;
  private handler: MidiCcHandler | null = null;
  private boundInputs = new Map<MIDIInput, (ev: MIDIMessageEvent) => void>();

  get isAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async start(onCc: MidiCcHandler): Promise<void> {
    if (!this.isAvailable) {
      throw new Error('Web MIDI is not supported in this browser');
    }
    await this.stop();
    this.handler = onCc;
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    for (const input of this.access.inputs.values()) {
      this.attachInput(input);
    }
    this.access.onstatechange = (event) => {
      const port = event.port;
      if (!port || port.type !== 'input') return;
      if (port.state === 'connected') {
        this.attachInput(port as MIDIInput);
      } else {
        this.detachInput(port as MIDIInput);
      }
    };
  }

  async stop(): Promise<void> {
    if (this.access) {
      this.access.onstatechange = null;
      for (const input of this.access.inputs.values()) {
        this.detachInput(input);
      }
      this.access = null;
    }
    this.handler = null;
    this.boundInputs.clear();
  }

  private attachInput(input: MIDIInput): void {
    if (this.boundInputs.has(input)) return;
    const listener = (event: MIDIMessageEvent) => {
      const data = event.data;
      if (!data || data.length < 3 || !this.handler) return;
      const status = data[0];
      const type = status & 0xf0;
      if (type !== 0xb0) return; // Control Change only
      const channel = status & 0x0f;
      const controller = data[1];
      const value = data[2];
      this.handler(channel, controller, value);
    };
    input.addEventListener('midimessage', listener);
    this.boundInputs.set(input, listener);
  }

  private detachInput(input: MIDIInput): void {
    const listener = this.boundInputs.get(input);
    if (listener) {
      input.removeEventListener('midimessage', listener);
      this.boundInputs.delete(input);
    }
  }
}

export function findBinding(
  bindings: readonly MidiBinding[],
  channel: number,
  controller: number,
): MidiBinding | undefined {
  return bindings.find(
    (b) => b.controller === controller && (b.channel < 0 || b.channel === channel),
  );
}

export function upsertBinding(
  bindings: MidiBinding[],
  binding: MidiBinding,
): MidiBinding[] {
  const next = bindings.filter(
    (b) => !(b.param === binding.param && b.controller === binding.controller
      && (b.channel < 0 || binding.channel < 0 || b.channel === binding.channel)),
  );
  return [...next, binding];
}

export function bindingKey(binding: MidiBinding): string {
  return `${binding.channel}:${binding.controller}→${binding.param}`;
}

export function isMidiParamId(value: string): value is MidiParamId {
  return value in {
    'layers.extensions.0': 1,
    'layers.extensions.1': 1,
    'layers.extensions.2': 1,
    'tracers.aboveIntensity': 1,
    'tracers.belowIntensity': 1,
    'engine.avgLuminance': 1,
  };
}
