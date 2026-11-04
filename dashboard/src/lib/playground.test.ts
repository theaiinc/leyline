
import { formatRunCost, maskedCodeSnippets, modesForModel } from './playground';

describe('playground modality helpers', () => {
  it('only exposes capabilities reported by a model', () => {
    expect(modesForModel({ id: 'vision', capabilities: { chat: true, vision: true } })).toEqual(['chat']);
    expect(modesForModel({ id: 'speech', capabilities: { speech: true } })).toEqual(['speech']);
    expect(modesForModel({ id: 'transcribe', capabilities: { transcription: true } })).toEqual(['transcription']);
    expect(modesForModel({ id: 'embed', capabilities: { embeddings: true } })).toEqual(['embeddings']);
    expect(modesForModel({ id: 'empty', capabilities: { image: true, video: true } })).toEqual([]);
  });

  it('builds masked-key snippets for each served API mode', () => {
    for (const mode of ['chat', 'speech', 'transcription', 'embeddings'] as const) {
      const snippets = maskedCodeSnippets(mode, 'provider/model', 'hello "world"');
      expect(snippets.curl).toContain('$VALEFRONT_API_KEY');
      expect(snippets.python).toContain('$VALEFRONT_API_KEY');
      expect(snippets.javascript).toContain('$VALEFRONT_API_KEY');
      expect(snippets.curl).not.toContain('sk-');
    }
  });

  it('formats published and unpublished run costs', () => {
    expect(formatRunCost(0.000001)).toBe('$0.000001');
    expect(formatRunCost(undefined)).toBe('price not published');
  });
});