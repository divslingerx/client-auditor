export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  onRetry?: (error: Error, attempt: number) => void;
  shouldRetry?: (error: Error) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    onRetry = () => {},
    shouldRetry = () => true
  } = options;

  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      onRetry(error, attempt);

      await new Promise(resolve => setTimeout(resolve, delay));

      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError!;
}

export function isRetryableError(error: Error): boolean {
  const message = error.message?.toLowerCase() || '';

  const retryablePatterns = [
    'timeout',
    'timed out',
    'protocol error',
    'page.enable',
    'target closed',
    'session closed',
    'page crashed',
    'net::err_',
    'network error',
    'navigation failed',
    'context destroyed',
    'execution context was destroyed',
    'cannot find context',
    'frame was detached'
  ];

  return retryablePatterns.some(pattern => message.includes(pattern));
}

export function isNetworkError(error: Error): boolean {
  const message = error.message?.toLowerCase() || '';

  const networkPatterns = [
    'net::err_',
    'econnrefused',
    'enotfound',
    'etimedout',
    'econnreset',
    'socket hang up',
    'network error'
  ];

  return networkPatterns.some(pattern => message.includes(pattern));
}