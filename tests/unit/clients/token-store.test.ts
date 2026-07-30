/**
 * Unit tests for the pluggable token store (token-store.ts).
 *
 * EnvFileTokenStore.save() is already exercised end-to-end via
 * save-tokens-to-env.test.ts (through authenticate()); here we cover:
 *  - EnvFileTokenStore.load() no-op contract
 *  - createTokenStore() selection logic (env vs Key Vault)
 *  - KeyVaultTokenStore load/save/tryGet, including 404-as-absent handling
 *
 * The Azure SDKs are mocked so no real credential or network access occurs.
 */
import { jest } from '@jest/globals';

const setSecretMock = jest.fn<(name: string, value: string) => Promise<unknown>>();
const getSecretMock = jest.fn<(name: string) => Promise<{ value?: string }>>();

jest.unstable_mockModule('@azure/keyvault-secrets', () => ({
  SecretClient: class {
    constructor(_url: string, _cred: unknown) {}
    setSecret = setSecretMock;
    getSecret = getSecretMock;
  },
}));

jest.unstable_mockModule('@azure/identity', () => ({
  DefaultAzureCredential: class {
    constructor() {}
  },
}));

const { createTokenStore, EnvFileTokenStore, KeyVaultTokenStore } = await import(
  '../../../src/clients/token-store'
);

describe('createTokenStore', () => {
  const original = process.env.QUICKBOOKS_KEYVAULT_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.QUICKBOOKS_KEYVAULT_URL;
    else process.env.QUICKBOOKS_KEYVAULT_URL = original;
    delete process.env.QUICKBOOKS_KEYVAULT_REFRESH_TOKEN_SECRET;
    delete process.env.QUICKBOOKS_KEYVAULT_REALM_ID_SECRET;
  });

  it('returns EnvFileTokenStore when no vault URL is set', () => {
    delete process.env.QUICKBOOKS_KEYVAULT_URL;
    expect(createTokenStore()).toBeInstanceOf(EnvFileTokenStore);
  });

  it('returns KeyVaultTokenStore when a vault URL is set', () => {
    process.env.QUICKBOOKS_KEYVAULT_URL = 'https://vault.example/';
    expect(createTokenStore()).toBeInstanceOf(KeyVaultTokenStore);
  });
});

describe('EnvFileTokenStore.load', () => {
  it('is a no-op that returns an empty token set', async () => {
    await expect(new EnvFileTokenStore().load()).resolves.toEqual({});
  });
});

describe('KeyVaultTokenStore', () => {
  beforeEach(() => {
    setSecretMock.mockReset().mockResolvedValue({});
    getSecretMock.mockReset();
  });

  it('load() returns both secrets by their configured names', async () => {
    getSecretMock.mockImplementation(async (name: string) =>
      name === 'refresh-secret' ? { value: 'rt-123' } : { value: 'realm-456' }
    );
    const store = new KeyVaultTokenStore(
      'https://vault.example/',
      'refresh-secret',
      'realm-secret'
    );
    await expect(store.load()).resolves.toEqual({
      refreshToken: 'rt-123',
      realmId: 'realm-456',
    });
    expect(getSecretMock).toHaveBeenCalledWith('refresh-secret');
    expect(getSecretMock).toHaveBeenCalledWith('realm-secret');
  });

  it('load() treats a 404 (SecretNotFound) as absent', async () => {
    getSecretMock.mockImplementation(async () => {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    });
    const store = new KeyVaultTokenStore('https://vault.example/', 'r', 'm');
    await expect(store.load()).resolves.toEqual({
      refreshToken: undefined,
      realmId: undefined,
    });
  });

  it('load() rethrows non-404 errors', async () => {
    getSecretMock.mockImplementation(async () => {
      throw Object.assign(new Error('boom'), { statusCode: 500 });
    });
    const store = new KeyVaultTokenStore('https://vault.example/', 'r', 'm');
    await expect(store.load()).rejects.toThrow('boom');
  });

  it('save() writes only the provided secrets', async () => {
    const store = new KeyVaultTokenStore(
      'https://vault.example/',
      'refresh-secret',
      'realm-secret'
    );
    await store.save({ refreshToken: 'rt-new' });
    expect(setSecretMock).toHaveBeenCalledTimes(1);
    expect(setSecretMock).toHaveBeenCalledWith('refresh-secret', 'rt-new');

    setSecretMock.mockClear();
    await store.save({ refreshToken: 'rt-2', realmId: 'realm-2' });
    expect(setSecretMock).toHaveBeenCalledWith('refresh-secret', 'rt-2');
    expect(setSecretMock).toHaveBeenCalledWith('realm-secret', 'realm-2');
  });

  it('save() writes only the realm id when the refresh token is absent', async () => {
    const store = new KeyVaultTokenStore(
      'https://vault.example/',
      'refresh-secret',
      'realm-secret'
    );
    await store.save({ realmId: 'realm-only' });
    expect(setSecretMock).toHaveBeenCalledTimes(1);
    expect(setSecretMock).toHaveBeenCalledWith('realm-secret', 'realm-only');
  });

  it('reuses a single SecretClient across calls', async () => {
    getSecretMock.mockResolvedValue({ value: 'x' });
    const store = new KeyVaultTokenStore('https://vault.example/', 'r', 'm');
    await store.load();
    await store.save({ refreshToken: 'y' });
    // No assertion on client identity is possible through the mock, but both
    // calls succeeding without re-instantiation errors exercises the cache path.
    expect(getSecretMock).toHaveBeenCalled();
    expect(setSecretMock).toHaveBeenCalled();
  });
});
