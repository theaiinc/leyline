import { RequestPiiRedactor } from '../src/core/pii-redaction';

describe('request-scoped PII redaction', () => {
  it('redacts and rehydrates email and phone values without logging values', async () => {
    const events: unknown[] = [];
    const redactor = new RequestPiiRedactor({
      mode: 'regex',
      log: (event) => events.push(event),
    });

    const input = {
      messages: [{
        role: 'user',
        content: 'Contact Ada at ada@example.com or +1 212-555-0199.',
      }],
    };
    const redacted = await redactor.redact(input);

    expect(JSON.stringify(redacted)).not.toContain('ada@example.com');
    expect(JSON.stringify(redacted)).not.toContain('212-555-0199');

    const response = redactor.rehydrate('Received <email:1> and <phone:1>.');
    expect(response).toContain('ada@example.com');
    expect(response).toContain('+1 212-555-0199');

    await redactor.finish();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
    expect(JSON.stringify(events[0])).not.toContain('212-555-0199');
    expect((events[0] as { counts: Record<string, number> }).counts.email).toBeGreaterThan(0);
    expect((events[0] as { counts: Record<string, number> }).counts.phone).toBeGreaterThan(0);
  });

  it('rehydrates tokens split across streamed chunks', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    await redactor.redact('Email ada@example.com');

    expect(redactor.rehydrate('answer <em')).toBe('answer ');
    expect(redactor.rehydrate('ail:1>')).toBe('ada@example.com');
    expect(redactor.finishStream()).toBe('');
  });

  it('preserves allowlisted values', async () => {
    const redactor = new RequestPiiRedactor({
      mode: 'regex',
      allowlist: ['@example\\.com'],
    });

    const output = await redactor.redact('ada@example.com and ada@other.test');
    expect(output).toContain('ada@example.com');
    expect(output).not.toContain('ada@other.test');
  });

  it('falls back from presidio when no analyzer URL is configured', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'presidio' });
    const output = await redactor.redact('ada@example.com');

    expect(output).not.toContain('ada@example.com');
    expect(redactor.stats.presidioFallback).toBe(true);
    expect(redactor.stats.mode).toBe('presidio');
  });
});