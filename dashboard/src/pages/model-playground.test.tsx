import { modesForModel } from '../lib/playground';

describe('model playground capability filtering', () => {
  it('does not expose unsupported media modes', () => {
    expect(modesForModel({ id: 'chat-only', capabilities: { chat: true } })).toEqual(['chat']);
    expect(modesForModel({ id: 'unsupported', capabilities: {} })).toEqual([]);
  });
}); 