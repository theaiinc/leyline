import { deployHealth } from '../src/core/deploy-health';

describe('deployHealth', () => {
  it('includes the deployed commit when provided', () => {
    expect(deployHealth('abc123')).toEqual({ status: 'ok', service: 'leyline', commit: 'abc123' });
  });

  it('keeps local health responses compatible without a commit', () => {
    expect(deployHealth()).toEqual({ status: 'ok', service: 'leyline' });
  });
});
