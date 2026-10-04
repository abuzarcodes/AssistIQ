import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Checkpoint 5 — the Node half of the AI service boundary.
 *
 * The Python service refuses any request without `X-API-Key`, so every outbound call
 * must present it. `requestFormData` builds its own headers (it cannot reuse the JSON
 * `headers` getter, which would set a Content-Type and break the multipart boundary),
 * so it is the path most likely to be forgotten — it is asserted explicitly.
 */

const fetchMock = vi.fn();

const { aiServiceClient } = await import('../src/services/aiServiceClient.js');

const okResponse = (body: unknown = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** Headers of the nth fetch call, normalised to a plain object. */
const headersOf = (callIndex = 0): Record<string, string> =>
  fetchMock.mock.calls[callIndex][1].headers as Record<string, string>;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse({ status: 'success' }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('AIServiceClient sends the service-to-service API key', () => {
  it('sends X-API-Key on JSON requests', async () => {
    await aiServiceClient.chat({ bot_id: 'bot-1', message: 'hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOf()).toMatchObject({
      'Content-Type': 'application/json',
      'X-API-Key': 'test-ai-service-key',
    });
  });

  it('sends X-API-Key on GET requests', async () => {
    await aiServiceClient.getAiStatus();

    expect(headersOf()['X-API-Key']).toBe('test-ai-service-key');
  });

  it('sends X-API-Key on multipart uploads without setting Content-Type', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'doc.txt');

    await aiServiceClient.ingestDocument(form);

    const headers = headersOf();
    expect(headers['X-API-Key']).toBe('test-ai-service-key');
    // fetch must be free to generate the multipart boundary itself.
    expect(headers).not.toHaveProperty('Content-Type');
  });

  it('targets the configured AI service base URL', async () => {
    await aiServiceClient.getAiStatus();

    expect(fetchMock.mock.calls[0][0]).toBe('http://ai.test/api/v1/ai/status');
  });
});

/**
 * Checkpoint 8 — what survives an AI service rejection.
 *
 * The status code is always 502: the AI service is a dependency and it failed to serve the
 * request. What these pin is the *reason*, because that is the part call sites depend on.
 * `ingestFile` records it as the source's `errorMessage`, and `deleteChunk` reads the
 * upstream status to decide whether a missing vector is a failure or an already-done job.
 * Losing either would restore the two bugs this block exists to catch: a malformed PDF
 * reported as an outage, and a chunk row that can never be deleted.
 */

describe('AIServiceClient distinguishes whose request failed', () => {
  const errorResponse = (status: number, body: unknown) => ({
    ok: false,
    status,
    json: async () => body,
  });

  /** Capture the rejection so the error's own fields can be inspected. */
  const caught = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (err) {
      return err as Error & { upstreamStatus?: number; upstreamDetail?: string; statusCode?: number };
    }
    throw new Error('expected the call to reject');
  };

  it('carries a 4xx detail through as the message, with the upstream status attached', async () => {
    // The malformed-PDF case (section 18.2). The AI service's own words are the only thing
    // that tells the user which file to fix.
    fetchMock.mockResolvedValue(
      errorResponse(400, { detail: 'Failed to process PDF file: cannot read stream' })
    );

    const err = await caught(() => aiServiceClient.getAiStatus());

    expect(err.message).toBe('Failed to process PDF file: cannot read stream');
    expect(err.statusCode).toBe(502);
    expect(err.upstreamStatus).toBe(400);
    expect(err.upstreamDetail).toBe('Failed to process PDF file: cannot read stream');
  });

  it('keeps the generic message for a 5xx, so internals never reach the customer', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(500, { detail: 'psycopg.OperationalError: connection refused at 10.0.0.4' })
    );

    const err = await caught(() => aiServiceClient.getAiStatus());

    expect(err.message).toBe('The AI service is currently unavailable. Please try again later.');
    expect(err.statusCode).toBe(502);
    // Kept on the error for the logs and for call sites that branch on it — merely not shown.
    expect(err.upstreamStatus).toBe(500);
  });

  it('carries the upstream status on a 404 so a caller can treat it as already-absent', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, { detail: 'Chunk not found.' }));

    const err = await caught(() => aiServiceClient.getAiStatus());

    expect(err.upstreamStatus).toBe(404);
  });

  it('survives an error body that is not JSON at all', async () => {
    // A proxy or a crashed worker can answer with HTML or nothing. The status is still
    // meaningful and must not be lost to a parse failure.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    const err = await caught(() => aiServiceClient.getAiStatus());

    expect(err.message).toBe('The AI service is currently unavailable. Please try again later.');
    expect(err.upstreamStatus).toBe(502);
  });

  it('reports a connection failure with no upstream status, since nothing answered', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await caught(() => aiServiceClient.getAiStatus());

    expect(err.message).toBe('The AI service is currently unavailable. Please try again later.');
    expect(err.statusCode).toBe(502);
    expect(err.upstreamStatus).toBeUndefined();
  });
});
