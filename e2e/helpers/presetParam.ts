/** Build a ?preset= base64url value matching the app's encodeSettingsParam format. */
export function encodePresetParam(document: unknown): string {
  const json = JSON.stringify(document);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Minimal preset document used by preset-url E2E (mirrors unit-test fixtures). */
export const SAMPLE_PRESET_DOCUMENT = {
  version: 1,
  settings: {
    layers: { angles: [12, 34, 56], colorMode: 0, opacity: 0.66 },
    tracers: { aboveIntensity: 0.42, belowDuration: 3500 },
    output: { outputMode: 1, stampBoost: 2.5 },
  },
} as const;
