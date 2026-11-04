import React from 'react';
import { render, screen } from '@testing-library/react';

import { ModelPlaygroundPage } from './model-playground';

jest.mock('@/api', () => ({
  api: jest.fn(),
  apiUrl: (path: string) => path,
}));

jest.mock('@/hooks/use-dashboard', () => ({
  useDashboard: () => ({
    stats: { providers: [] },
    session: null,
  }),
}));

describe('model playground modes', () => {
  it('renders an empty model state without inventing unsupported modes', () => {
    render(<ModelPlaygroundPage />);
    expect(screen.getByText('No served models are available.')).toBeTruthy();
    expect(screen.queryByText('Speech')).toBeNull();
    expect(screen.queryByText('Transcription')).toBeNull();
    expect(screen.queryByText('Embeddings')).toBeNull();
  });
});