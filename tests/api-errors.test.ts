import { chatCompletionErrorResponse, formatProviderError, isRateLimitError } from '../src/core/api-errors';

describe('api-errors', () => {
  it('detects Leyline and provider rate limit errors', () => {
    expect(isRateLimitError(new Error('Fixed provider AzureOpenAI is rate-limited.'))).toBe(true);
    expect(isRateLimitError({ response: { status: 429 }, message: 'Request failed with status code 429' })).toBe(true);
    expect(isRateLimitError(new Error('Service Unavailable'))).toBe(false);
  });

  it('returns OpenAI-style 429 payloads for rate limits', () => {
    const response = chatCompletionErrorResponse({
      response: {
        status: 429,
        data: { error: { message: 'Rate limit reached for requests' } },
      },
      message: 'Request failed with status code 429',
    });

    expect(response.status).toBe(429);
    expect(response.body.error).toMatchObject({
      message: 'Rate limit reached for requests',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    });
  });

  it('formats axios stream errors without throwing on circular response bodies', () => {
    const circularBody = { pipe: () => undefined };
    expect(() => formatProviderError({
      message: 'Request failed with status code 400',
      response: { status: 400, statusText: 'Bad Request', data: circularBody },
    })).not.toThrow();

    expect(formatProviderError({
      message: 'Request failed with status code 400',
      response: { status: 400, statusText: 'Bad Request', data: circularBody },
    })).toBe('HTTP 400 Bad Request: Request failed with status code 400');
  });
});
