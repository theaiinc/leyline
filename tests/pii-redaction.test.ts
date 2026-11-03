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

    const response = redactor.rehydrate('Received <email:1> and <phone:2>.');
    expect(response).toContain('ada@example.com');
    expect(response).toContain('+1 212-555-0199');

    await redactor.finish();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
    expect(JSON.stringify(events[0])).not.toContain('212-555-0199');
    expect((events[0] as { counts: Record<string, number> }).counts.email).toBeGreaterThan(0);
    expect((events[0] as { counts: Record<string, number> }).counts.phone).toBeGreaterThan(0);
  });

  it('keeps URLs unchanged across messages', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    const request = await redactor.redact({
      messages: [
        { role: 'user', content: 'Primary https://llm.valefront.com' },
        { role: 'user', content: 'Alias https://llm.theaiinc.com' },
      ],
    });

    expect((request as { messages: Array<{ content: string }> }).messages.map((message) => message.content)).toEqual([
      'Primary https://llm.valefront.com',
      'Alias https://llm.theaiinc.com',
    ]);
  });

  it('assigns distinct tokens across messages and rehydrates each one', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    const request = await redactor.redact({
      messages: [
        { role: 'user', content: 'First ada@example.com' },
        { role: 'user', content: 'Second grace@example.com and third linus@example.com' },
      ],
    });
    const contents = (request as { messages: Array<{ content: string }> }).messages.map((message) => message.content);

    expect(contents[0]).toContain('VF_EMAIL_1X');
    expect(contents[1]).toContain('VF_EMAIL_2X and third VF_EMAIL_3X');
    expect(redactor.rehydrate(contents.join(' '))).toBe('First ada@example.com Second grace@example.com and third linus@example.com');
  });

  it('reuses one token for the same email across messages', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    const request = await redactor.redact({
      messages: [
        { role: 'user', content: 'First ada@example.com' },
        { role: 'user', content: 'Again ada@example.com' },
      ],
    });
    const contents = (request as { messages: Array<{ content: string }> }).messages.map((message) => message.content);

    expect(contents).toEqual(['First VF_EMAIL_1X', 'Again VF_EMAIL_1X']);
    expect(redactor.rehydrate(contents.join(' '))).toBe('First ada@example.com Again ada@example.com');
  });

  it('does not rewrite non-PII technical text while masking and rehydrating PII', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    const content = 'packages/storage/src/database.ts, databaseStorage, database, database, event streaming platform, distributed messaging system. Contact person@example.com at +1 (415) 555-0132.';
    const redacted = await redactor.redact({ messages: [{ role: 'user', content }] });
    const masked = (redacted as { messages: Array<{ content: string }> }).messages[0].content;

    expect(masked).toContain('packages/storage/src/database.ts, databaseStorage, database, database, event streaming platform, distributed messaging system.');
    expect(masked).not.toContain('person@example.com');
    expect(masked).not.toContain('+1 (415) 555-0132');
    expect(redactor.rehydrate(masked)).toBe(content);
    expect(redactor.rehydrate('Reply to ada@example.com or +1 212-555-0199.')).toContain('ada@example.com');
    expect(redactor.rehydrate('Reply to ada@example.com or +1 212-555-0199.')).toContain('+1 212-555-0199');
  });

  it('rehydrates tokens split across streamed chunks', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    await redactor.redact('Email ada@example.com');

    expect(redactor.rehydrateStream('answer VF_EM')).toBe('answer ');
    expect(redactor.rehydrateStream('AIL_1X')).toBe('ada@example.com');
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

  it('flushes partial content and tool argument channels independently', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    await redactor.redact('Email ada@example.com or +1 212-555-0199');

    expect(redactor.rehydrateStream('VF_EM', 'choice:0:content')).toBe('');
    expect(redactor.rehydrateStream('VF_PH', 'choice:0:tool:0')).toBe('');
    expect(redactor.finishStream('choice:0:content')).toBe('VF_EM');
    expect(redactor.finishStream('choice:0:tool:0')).toBe('VF_PH');
  });

  it('flushes a partial content tail before stream completion', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    await redactor.redact('Email ada@example.com');
    expect(redactor.rehydrateStream('Answer VF_EMAIL_', 'choice:0:content')).toBe('Answer ');
    expect(redactor.finishStream('choice:0:content')).toBe('VF_EMAIL_');
  });

  it('flushes a partial tool-argument tail before stream completion', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    await redactor.redact('Email ada@example.com');
    expect(redactor.rehydrateStream('{"email":"VF_EMAIL_', 'choice:0:tool:0')).toBe('{"email":"');
    expect(redactor.finishStream('choice:0:tool:0')).toBe('VF_EMAIL_');
  });

  it('rehydrates messages-format content and tool arguments', async () => {
    const redactor = new RequestPiiRedactor({ mode: 'regex' });
    const request = await redactor.redact({
      messages: [
        { role: 'user', content: 'Contact ada@example.com' },
        { role: 'tool', content: 'Result for ada@example.com' },
      ],
});

expect(JSON.stringify(request)).not.toContain('ada@example.com');
expect(redactor.rehydrate('Answer for <email:1>')).toContain('ada@example.com');
expect(redactor.rehydrateValue({ input: '<email:1>' })).toEqual({ input: 'ada@example.com' });
});

it('rehydrates HTML and JSON-escaped tool arguments', async () => {
  const redactor = new RequestPiiRedactor({ mode: 'regex' });
  await redactor.redact({
    messages: [{
      role: 'user',
      content: 'Contact ada@example.com at +1 212-555-0199',
    }],
  });

  expect(redactor.rehydrate('&lt;email:1&gt; and &lt;phone:2&gt;')).toBe('ada@example.com and +1 212-555-0199');
  expect(redactor.rehydrateValue({
    input: '\\<email:1\\>',
    phone: '&lt;phone:2&gt;',
  })).toEqual({
    input: 'ada@example.com',
    phone: '+1 212-555-0199',
  });
});

it('rehydrates new tokens and split streams without leaving placeholders', async () => {
  const redactor = new RequestPiiRedactor({ mode: 'regex' });
  await redactor.redact('Contact ada@example.com at +1 212-555-0199');

  const masked = await redactor.redact({
    messages: [{
      role: 'user',
      content: 'Contact grace@example.com',
    }],
  });
  const token = (masked as { messages: Array<{ content: string }> }).messages[0].content.match(/VF_[A-Z0-9_]+X/)?.[0];
  expect(token).toBeTruthy();
  expect(redactor.rehydrate(token!)).toBe('grace@example.com');

  for (const split of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const streamRedactor = new RequestPiiRedactor({ mode: 'regex' });
    await streamRedactor.redact('Contact ada@example.com');
    const streamToken = streamRedactor.rehydrate('VF_EMAIL_1X');
    expect(streamToken).toBe('ada@example.com');
    const first = 'answer VF_EMAIL_1X'.slice(0, split);
    const second = 'answer VF_EMAIL_1X'.slice(split);
    const output = streamRedactor.rehydrateStream(first, `split-${split}`)
      + streamRedactor.rehydrateStream(second, `split-${split}`)
      + streamRedactor.finishStream(`split-${split}`);
    expect(output).not.toMatch(/VF_[A-Z0-9_]+X/);
  }
});

it('rehydrates Anthropic text and tool-use payloads', async () => {
  const redactor = new RequestPiiRedactor({ mode: 'regex' });
  await redactor.redact('Contact ada@example.com');
  expect(redactor.rehydrateValue({
    content_block: { type: 'text_delta', text: 'VF_EMAIL_1X' },
    input_json_delta: { partial_json: '{"email":"VF_EMAIL_1X"}' },
    tool_use: { input: { email: 'VF_EMAIL_1X' } },
  })).toEqual({
    content_block: { type: 'text_delta', text: 'ada@example.com' },
    input_json_delta: { partial_json: '{"email":"ada@example.com"}' },
    tool_use: { input: { email: 'ada@example.com' } },
  });
});

it('never leaves a generated token across random stream splits', async () => {
  const redactor = new RequestPiiRedactor({ mode: 'regex' });
  await redactor.redact('Contact ada@example.com');
  const value = 'VF_EMAIL_1X';
  for (let seed = 1; seed <= 32; seed += 1) {
    const streamRedactor = new RequestPiiRedactor({ mode: 'regex' });
    await streamRedactor.redact('Contact ada@example.com');
    let output = '';
    let offset = 0;
    let step = seed % 5 + 1;
    while (offset < value.length) {
      const next = Math.min(value.length, offset + step);
      output += streamRedactor.rehydrateStream(value.slice(offset, next), `random-${seed}`);
      offset = next;
      step = (step * 3 + seed) % 7 + 1;
    }
    output += streamRedactor.finishStream(`random-${seed}`);
    expect(output).toBe('ada@example.com');
  }
});

it('falls back from presidio when no analyzer URL is configured', async () => {
  const redactor = new RequestPiiRedactor({ mode: 'presidio' });
  const output = await redactor.redact('ada@example.com');

  expect(output).not.toContain('ada@example.com');
  expect(redactor.stats.presidioFallback).toBe(true);
  expect(redactor.stats.mode).toBe('presidio');
});
});