import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from './id';

afterEach(() => vi.unstubAllGlobals());

describe('UUID generation across browser contexts', () => {
  it('uses native randomUUID when the browser exposes it', () => {
    const randomUUID = vi.fn(() => '01f6a8f1-eaab-4ad4-8213-f8aa5c3a89d2');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    expect(createId()).toBe('01f6a8f1-eaab-4ad4-8213-f8aa5c3a89d2');
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('uses getRandomValues when randomUUID is missing on LAN HTTP and sets version/variant bits', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const id = createId();
    expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('fails clearly instead of generating weak Math.random identifiers when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => createId()).toThrow('不支持安全随机标识');
  });
});
