import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The rotating OAuth credentials that must survive process restarts. */
export interface TokenSet {
  refreshToken?: string;
  realmId?: string;
}

/**
 * Pluggable persistence for the QuickBooks refresh token / realm id.
 *
 * Intuit rotates the refresh token (~daily); whatever store is in use MUST
 * durably persist the rotated value or refresh eventually breaks. The default
 * EnvFileTokenStore writes to .env (fine for local/stdio use). On ephemeral
 * container hosts (Azure Container Apps), select KeyVaultTokenStore instead so
 * the rotated token survives restarts and revisions.
 */
export interface TokenStore {
  /** Load persisted tokens at startup. Return {} to leave in-memory values as-is. */
  load(): Promise<TokenSet>;
  /** Persist tokens after the OAuth handshake or a refresh-token rotation. */
  save(tokens: TokenSet): Promise<void>;
}

/**
 * Default store: reads/writes the project-root .env, preserving the original
 * saveTokensToEnv() behaviour (symlink-aware, atomic rename for regular files).
 *
 * load() is intentionally a no-op: dotenv has already populated process.env at
 * client construction, so the in-memory values are authoritative for env mode.
 */
export class EnvFileTokenStore implements TokenStore {
  // Resolve .env relative to the installed module (../../.env from dist/clients/),
  // matching the original resolution so host apps with a different CWD still work.
  private readonly envPath = path.join(__dirname, "..", "..", ".env");

  async load(): Promise<TokenSet> {
    return {};
  }

  async save(tokens: TokenSet): Promise<void> {
    const tokenPath = this.envPath;
    const envContent = fs.existsSync(tokenPath)
      ? fs.readFileSync(tokenPath, "utf-8")
      : "";
    const envLines = envContent.split("\n");

    const updateEnvVar = (name: string, value: string) => {
      const index = envLines.findIndex((line) => line.startsWith(`${name}=`));
      if (index !== -1) {
        envLines[index] = `${name}=${value}`;
      } else {
        envLines.push(`${name}=${value}`);
      }
    };

    if (tokens.refreshToken)
      updateEnvVar("QUICKBOOKS_REFRESH_TOKEN", tokens.refreshToken);
    if (tokens.realmId) updateEnvVar("QUICKBOOKS_REALM_ID", tokens.realmId);

    const newContent = envLines.join("\n");

    if (this.isSymbolicLink(tokenPath)) {
      // Write directly through the symlink to the real target. Renaming over a
      // symlink replaces the link itself rather than writing through it, which
      // breaks persistent-volume mounts in containers. Resolve the target even
      // when it doesn't exist yet (fresh PVC mount / dangling symlink).
      let realPath: string;
      try {
        realPath = fs.realpathSync(tokenPath);
      } catch (e: any) {
        if (e?.code === "ENOENT") {
          const linkTarget = fs.readlinkSync(tokenPath);
          realPath = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(tokenPath), linkTarget);
        } else {
          throw e;
        }
      }
      // Deliberate: no temp-file+rename here (renaming over a symlink replaces
      // the link). Trades atomicity for correct persistent-volume behaviour.
      fs.writeFileSync(realPath, newContent, { mode: 0o600 });
    } else {
      // Atomic write: temp file + rename (atomic within one filesystem on POSIX).
      const tmpPath = `${tokenPath}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpPath, newContent, { mode: 0o600 });
        fs.renameSync(tmpPath, tokenPath);
      } catch (err) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }
        throw err;
      }
    }
  }

  private isSymbolicLink(filePath: string): boolean {
    try {
      return fs.lstatSync(filePath).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/**
 * Azure Key Vault store. Persists the rotating refresh token and realm id as
 * Key Vault secrets, authenticating via DefaultAzureCredential (a Container
 * App / App Service managed identity in production; az login / env creds
 * locally). The Azure SDKs are imported lazily so env-mode deployments never
 * pay their load cost.
 */
export class KeyVaultTokenStore implements TokenStore {
  private clientPromise?: Promise<import("@azure/keyvault-secrets").SecretClient>;

  constructor(
    private readonly vaultUrl: string,
    private readonly refreshSecretName: string,
    private readonly realmSecretName: string
  ) {}

  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SecretClient } = await import("@azure/keyvault-secrets");
        const { DefaultAzureCredential } = await import("@azure/identity");
        return new SecretClient(this.vaultUrl, new DefaultAzureCredential());
      })();
    }
    return this.clientPromise;
  }

  async load(): Promise<TokenSet> {
    const client = await this.getClient();
    return {
      refreshToken: await this.tryGet(client, this.refreshSecretName),
      realmId: await this.tryGet(client, this.realmSecretName),
    };
  }

  async save(tokens: TokenSet): Promise<void> {
    const client = await this.getClient();
    if (tokens.refreshToken)
      await client.setSecret(this.refreshSecretName, tokens.refreshToken);
    if (tokens.realmId)
      await client.setSecret(this.realmSecretName, tokens.realmId);
  }

  private async tryGet(
    client: import("@azure/keyvault-secrets").SecretClient,
    name: string
  ): Promise<string | undefined> {
    try {
      const secret = await client.getSecret(name);
      return secret.value;
    } catch (e: any) {
      // A not-yet-created secret is expected on first run; treat as absent.
      if (e?.statusCode === 404 || e?.code === "SecretNotFound") return undefined;
      throw e;
    }
  }
}

/**
 * Selects the token store from the environment. If QUICKBOOKS_KEYVAULT_URL is
 * set, tokens are persisted to Azure Key Vault; otherwise the local .env file.
 * Secret names default to Key Vault-safe values and are overridable so multiple
 * companies can share one vault.
 */
export function createTokenStore(): TokenStore {
  const vaultUrl = process.env.QUICKBOOKS_KEYVAULT_URL;
  if (vaultUrl) {
    const refreshSecretName =
      process.env.QUICKBOOKS_KEYVAULT_REFRESH_TOKEN_SECRET ??
      "quickbooks-refresh-token";
    const realmSecretName =
      process.env.QUICKBOOKS_KEYVAULT_REALM_ID_SECRET ?? "quickbooks-realm-id";
    return new KeyVaultTokenStore(vaultUrl, refreshSecretName, realmSecretName);
  }
  return new EnvFileTokenStore();
}
