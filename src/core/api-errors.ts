export function isRateLimitError(error: unknown): boolean {
  const candidate = error as { message?: string; response?: { status?: number } };
  const message = candidate?.message?.toLowerCase() || '';
  const status = candidate?.response?.status;

  return status === 429
    || message.includes('quota exceeded')
    || message.includes('is rate-limited')
    || message.includes('rate limit reached')
    || message.includes('too many requests');
}

function isPlainProviderData(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (typeof (value as { pipe?: unknown }).pipe === 'function') return false;

  const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
  return constructorName !== 'IncomingMessage'
    && constructorName !== 'ClientRequest'
    && constructorName !== 'Agent';
}

export async function readReadableStream(data: unknown): Promise<string> {
  if (!data || typeof data !== 'object') return '';

  const stream = data as AsyncIterable<unknown> & { on?: Function };
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  if (typeof stream.on === 'function') {
    const on = stream.on.bind(stream);
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      on('error', reject);
    });
  }

  return '';
}

export async function hydrateAxiosError(error: unknown): Promise<unknown> {
  const candidate = error as {
    message?: string;
    response?: { status?: number; data?: unknown };
  };

  if (!candidate.response?.data) return error;

  const data = candidate.response.data;
  const isStream = typeof data === 'object'
    && data !== null
    && (typeof (data as { pipe?: unknown }).pipe === 'function' || typeof (data as { on?: unknown }).on === 'function');

  if (!isStream) return error;

  try {
    const text = await readReadableStream(data);
    if (!text) return error;

    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { message: text } };
    }

    candidate.response.data = parsed;
  } catch {
    return error;
  }

  return error;
}

export function extractProviderErrorMessage(providerData: unknown, fallback: string): string {
  if (typeof providerData === 'string') {
    try {
      return extractProviderErrorMessage(JSON.parse(providerData), fallback);
    } catch {
      return providerData;
    }
  }

  if (!isPlainProviderData(providerData)) {
    return fallback;
  }

  const nestedError = providerData.error;
  if (typeof nestedError === 'object' && nestedError !== null) {
    const message = (nestedError as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  if (typeof providerData.message === 'string') return providerData.message;

  try {
    return JSON.stringify(providerData);
  } catch {
    return fallback;
  }
}

export function formatProviderError(error: unknown): string {
  const candidate = error as {
    message?: string;
    response?: { status?: number; statusText?: string; data?: unknown };
  };

  if (candidate.response) {
    const { status, statusText, data } = candidate.response;
    const detail = extractProviderErrorMessage(data, candidate.message || 'Request failed');
    const statusLabel = status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : 'HTTP error';
    return detail === candidate.message ? `${statusLabel}: ${detail}` : detail;
  }

  return candidate.message || 'Unknown error';
}

export function chatCompletionErrorResponse(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
  const candidate = error as { message?: string; response?: { status?: number; data?: unknown } };
  const message = candidate?.message || 'Unknown error';
  const providerStatus = candidate?.response?.status;
  const providerData = candidate?.response?.data;
  const providerMessage = extractProviderErrorMessage(providerData, message);

  if (isRateLimitError(error)) {
    return {
      status: 429,
      body: {
        error: {
          message: providerMessage,
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      },
    };
  }

  if (providerStatus === 400) {
    return {
      status: 400,
      body: {
        error: {
          message: providerMessage,
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      },
    };
  }

  return {
    status: providerStatus && providerStatus >= 400 && providerStatus < 600 ? providerStatus : 503,
    body: {
      error: {
        message: providerStatus ? providerMessage : `Service Unavailable: ${providerMessage}`,
        type: providerStatus && providerStatus >= 400 && providerStatus < 500 ? 'invalid_request_error' : 'service_unavailable',
        code: providerStatus || 503,
      },
    },
  };
}
