import { WaveSpeedProvider } from '../src/providers/wavespeed';

/**
 * Manual, local-only verification. The caller supplies WAVESPEED_API_KEY for
 * this process; this script never retrieves, prints, or persists the key.
 */
async function main(): Promise<void> {
  const provider = new WaveSpeedProvider();
  if (!provider.hasApiKey()) throw new Error('Set WAVESPEED_API_KEY for this command only');

  const image = await provider.predict('bfl', 'flux-dev', { prompt: 'a small red apple on white background', width: 512, height: 512 });
  const imageResult = await provider.poll(image.id);
  console.log(JSON.stringify({ kind: 'image', id: imageResult.id, status: imageResult.status, outputs: imageResult.outputs, reportedCost: imageResult.cost, computedCost: 0.025 }));

  const lipSync = await provider.predict('bytedance', 'latentsync', { video: 'https://example.com/tiny-video.mp4', audio: 'https://example.com/tiny-audio.wav' });
  const lipSyncResult = await provider.poll(lipSync.id);
  console.log(JSON.stringify({ kind: 'lip-sync', id: lipSyncResult.id, status: lipSyncResult.status, outputs: lipSyncResult.outputs, reportedCost: lipSyncResult.cost, computedCost: 0.15 }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'WaveSpeed smoke failed');
  process.exitCode = 1;
});
