// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { findRetryAfterTimeFromError } from '../../../jobs/helpers/findRetryAfterTimeFromError';
import { HTTPError } from '../../../textsecure/Errors';

describe('findRetryAfterTimeFromError', () => {
  it('returns 1 second if no Retry-After time is found', () => {
    [
      undefined,
      null,
      {},
      { responseHeaders: {} },
      { responseHeaders: { 'retry-after': 'garbage' } },
      {
        httpError: new HTTPError('Slow down', {
          code: 413,
          headers: {},
          response: {},
        }),
      },
      {
        httpError: new HTTPError('Slow down', {
          code: 413,
          headers: { 'retry-after': 'garbage' },
          response: {},
        }),
      },
    ].forEach(input => {
      assert.strictEqual(findRetryAfterTimeFromError(input), 1000);
    });
  });

  it("returns 1 second if a Retry-After time is found, but it's less than 1 second", () => {
    ['0', '-99', '0.5'].forEach(headerValue => {
      const input = { responseHeaders: { 'retry-after': headerValue } };
      assert.strictEqual(findRetryAfterTimeFromError(input), 1000);
    });
  });

  it('returns 1 second for extremely large numbers', () => {
    const input = { responseHeaders: { 'retry-after': '999999999999999999' } };
    assert.strictEqual(findRetryAfterTimeFromError(input), 1000);
  });

  it('finds the retry-after time on top-level response headers', () => {
    const input = { responseHeaders: { 'retry-after': '1234' } };
    assert.strictEqual(findRetryAfterTimeFromError(input), 1234 * 1000);
  });

  it("finds the retry-after time on an HTTP error's response headers", () => {
    const input = {
      httpError: new HTTPError('Slow down', {
        code: 413,
        headers: { 'retry-after': '1234' },
        response: {},
      }),
    };
    assert.strictEqual(findRetryAfterTimeFromError(input), 1234 * 1000);
  });

  it('prefers the top-level response headers over an HTTP error', () => {
    const input = {
      responseHeaders: { 'retry-after': '1234' },
      httpError: new HTTPError('Slow down', {
        code: 413,
        headers: { 'retry-after': '999' },
        response: {},
      }),
    };
    assert.strictEqual(findRetryAfterTimeFromError(input), 1234 * 1000);
  });
});