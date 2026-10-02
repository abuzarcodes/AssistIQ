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
