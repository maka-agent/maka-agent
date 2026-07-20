export interface CodexOAuthHarnessCredentialPaths {
  makaAccessTokenPath: string;
  codexAuthJsonPath: string;
}

export interface CodexOAuthHarnessCredentialInput {
  credentialsRoot: string;
  connectionSlug: string;
  codexAuthJsonPath: string;
}

export async function withCodexOAuthHarnessCredentials<T>(
  input: CodexOAuthHarnessCredentialInput,
  run: (paths: CodexOAuthHarnessCredentialPaths) => Promise<T>,
): Promise<T> {
  const tokens = await resolveOAuthSubscriptionTokens({
    providerType: 'openai-codex',
    slug: input.connectionSlug,
    credentialStore: createFileCredentialStore(input.credentialsRoot),
  });
  if (!tokens) throw new Error('Maka Codex OAuth credentials are unavailable');

  const codexAuthRaw = await readFile(input.codexAuthJsonPath, 'utf8');
  const codexAuth = parseCodexAuthJson(codexAuthRaw);
  const makaAccountId = tokens.account_id ?? accountIdFromAccessToken(tokens.access_token);
  const codexAccountId =
    codexAuth.tokens.account_id ?? accountIdFromAccessToken(codexAuth.tokens.access_token);
  if (!makaAccountId || !codexAccountId) {
    throw new Error('Codex OAuth account identity is unavailable');
  }
  if (makaAccountId !== codexAccountId) {
    throw new Error('Maka and Codex CLI OAuth credentials belong to different accounts');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-'));
  await chmod(temporaryRoot, 0o700);
  const paths = {
    makaAccessTokenPath: join(temporaryRoot, 'maka-access-token'),
    codexAuthJsonPath: join(temporaryRoot, 'codex-auth.json'),
  };
  try {
    await writeFile(paths.makaAccessTokenPath, tokens.access_token, { mode: 0o600 });
    await writeFile(paths.codexAuthJsonPath, codexAuthRaw, { mode: 0o600 });
    return await run(paths);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface CodexAuthJson {
  auth_mode: 'chatgpt';
  tokens: { access_token: string; refresh_token: string; account_id?: string };
}

function parseCodexAuthJson(raw: string): CodexAuthJson {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Codex auth.json is not valid JSON', { cause: error });
  }
  if (!isRecord(value) || value.auth_mode !== 'chatgpt' || !isRecord(value.tokens)) {
    throw new Error('Codex auth.json must contain a ChatGPT login');
  }
  const accessToken = value.tokens.access_token;
  const refreshToken = value.tokens.refresh_token;
  const accountId = value.tokens.account_id;
  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    typeof refreshToken !== 'string' ||
    !refreshToken
  ) {
    throw new Error('Codex auth.json is missing OAuth tokens');
  }
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(typeof accountId === 'string' && accountId ? { account_id: accountId } : {}),
    },
  };
}

function accountIdFromAccessToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return null;
    const auth = payload['https://api.openai.com/auth'];
    if (isRecord(auth) && typeof auth.chatgpt_account_id === 'string') {
      return auth.chatgpt_account_id;
    }
    return typeof payload.chatgpt_account_id === 'string' ? payload.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOAuthSubscriptionTokens } from '@maka/runtime';
import { createFileCredentialStore } from '@maka/storage';
