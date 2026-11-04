import { computeWaveSpeedCost, WAVESPEED_CATALOG, WaveSpeedProvider } from '../src/providers/wavespeed';

const VIDEO_URL = 'https://static.wavespeed.ai/examples/latentsync/video.mp4';
const AUDIO_URL = 'https://static.wavespeed.ai/examples/latentsync/audio.wav';

async function wavDurationSeconds(url: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download audio fixture (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WAVE') {
    throw new Error('WaveSpeed smoke audio fixture is not a WAV file');
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataOffset = bytes.findIndex((_, index) => index + 4 <= bytes.length && new TextDecoder().decode(bytes.subarray(index, index + 4)) === 'data');
  if (dataOffset < 0 || channels === 0 || sampleRate === 0 || bitsPerSample === 0) throw new Error('Could not determine WAV duration');
  const dataSize = view.getUint32(dataOffset + 4, true);
  return dataSize / (sampleRate * channels * bitsPerSample / 8);
}

/** Manual testing only; the caller injects WAVESPEED_API_KEY with arcana. */
async function main(): Promise<void> {
  const provider = new WaveSpeedProvider();
  if (!provider.hasApiKey()) throw new Error('Set WAVESPEED_API_KEY for this command only');
  let totalSpend = 0;

  const image = await provider.predict('bfl', 'flux-dev', { prompt: 'a small red apple on white background', width: 512, height: 512 });
  const imageResult = await provider.poll(image.id);
  const imageCost = computeWaveSpeedCost(WAVESPEED_CATALOG[0], {});
  totalSpend += imageResult.cost ?? imageCost;
  console.log(JSON.stringify({ kind: 'image', id: imageResult.id, status: imageResult.status, outputs: imageResult.outputs, reportedCost: imageResult.cost, computedCost: imageCost, mismatch: imageResult.cost !== undefined && imageResult.cost !== imageCost }));

  const audioSeconds = await wavDurationSeconds(AUDIO_URL);
  if (audioSeconds < 3 || audioSeconds > 5) throw new Error(`Audio fixture is ${audioSeconds.toFixed(3)}s; expected 3–5s`);
  const lipSyncInput = { video: VIDEO_URL, audio: AUDIO_URL, audio_seconds: audioSeconds };
  const lipSync = await provider.predict('bytedance', 'latentsync', lipSyncInput);
  const lipSyncResult = await provider.poll(lipSync.id);
  const lipSyncCost = computeWaveSpeedCost(WAVESPEED_CATALOG[1], lipSyncInput);
  totalSpend += lipSyncResult.cost ?? lipSyncCost;
  console.log(JSON.stringify({ kind: 'lip-sync', id: lipSyncResult.id, status: lipSyncResult.status, outputs: lipSyncResult.outputs, audioSeconds, reportedCost: lipSyncResult.cost, computedCost: lipSyncCost, mismatch: lipSyncResult.cost !== undefined && lipSyncResult.cost !== lipSyncCost }));
  console.log(JSON.stringify({ totalSpend }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'WaveSpeed smoke failed');
  process.exitCode = 1;
});
