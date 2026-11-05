import { chatCompletionErrorResponse, formatProviderError, isInsufficientBalanceError, isRateLimitError } from '../src/core/api-errors';

describe('api-errors', () => {
  it('detects insufficient balance and credit exhaustion errors without classifying unrelated 400s', () => {
    expect(isInsufficientBalanceError({ response: { status: 402 }, message: 'Payment required' })).toBe(true);
    expect(isInsufficientBalanceError({ response: { status: 400, data: { error: { message: 'Insufficient balance' } } }, message: 'Bad request' })).toBe(true);
    expect(isInsufficientBalanceError(new Error('The account is out of credit'))).toBe(true);
    expect(isInsufficientBalanceError({ response: { status: 400 }, message: 'Invalid model name' })).toBe(false);
  });

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
