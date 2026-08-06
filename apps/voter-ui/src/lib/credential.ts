import {
  createCredentialRequest,
  finalizeCredential,
  RegistrarClient,
  verifyCredential,
  voterCodeHash,
  type CredentialRequestMaterial,
  type RsaPublicJwk,
} from '@votechain/protocol';
import { REGISTRAR_URL } from './config';

/**
 * Credential lifecycle with crash-safety.
 *
 * The registrar issues at most ONE credential per (code, election). To make
 * that safe against crashes and reloads, the blinded request material is
 * persisted to localStorage BEFORE it is sent: replaying the identical
 * blinded token is idempotent at the registrar (it returns the stored
 * signature), so a crash between request and response never burns the
 * voter's only credential.
 *
 * Device-privacy note (documented in SECURITY.md): the localStorage key
 * includes a truncated hash of the code, which links code→token ON THIS
 * DEVICE ONLY. The public record and the registrar never see that link.
 */

export interface StoredCredential {
  electionId: string;
  token: string;
  tokenSecretKey: string;
  tokenPrefix: string;
  credentialSig: string;
}

export type CredentialOutcome =
  | { status: 'ok'; credential: StoredCredential }
  | { status: 'already_issued' }
  | { status: 'unknown_code' | 'code_revoked' | 'error'; message: string };

function storageKeys(chainId: string, electionId: string, code: string): { cred: string; pending: string } {
  const codeKey = voterCodeHash(code).slice(0, 16);
  return {
    cred: `vc:cred:${chainId}:${electionId}:${codeKey}`,
    pending: `vc:pending:${chainId}:${electionId}:${codeKey}`,
  };
}

/**
 * The credential already on this device for an election, if there is one.
 *
 * This is what makes a refresh survivable without ever storing the voting code.
 * Once `ensureCredential` has run, the code has done its whole job: everything
 * that follows — casting, revoting, the receipt — needs only the credential
 * below. So a voter returning to a ballot after a reload, a Back, or closing
 * the tab can be resumed from storage, and is asked for their code only when
 * there is genuinely no credential yet.
 *
 * Scans by prefix because the key's last segment is a hash of the code, which
 * we no longer hold. That hash is 64 bits of SHA-256 over a 100-bit random
 * code: it is not a code leak, and it is already sitting in this same storage.
 */
export function findCredential(chainId: string, electionId: string): StoredCredential | null {
  const prefix = `vc:cred:${chainId}:${electionId}:`;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as StoredCredential;
      // Guard against a half-written or older-shaped entry.
      if (parsed.token && parsed.tokenSecretKey && parsed.credentialSig) return parsed;
    } catch {
      // Unreadable entry: ignore it and let the voter re-enter their code.
    }
  }
  return null;
}

export async function ensureCredential(
  chainId: string,
  electionId: string,
  credentialPublicKeyJwk: RsaPublicJwk,
  code: string,
): Promise<CredentialOutcome> {
  const keys = storageKeys(chainId, electionId, code);

  const stored = localStorage.getItem(keys.cred);
  if (stored) {
    return { status: 'ok', credential: JSON.parse(stored) as StoredCredential };
  }

  // Reuse persisted pending material (idempotent retry) or create fresh material.
  let material: CredentialRequestMaterial;
  const pending = localStorage.getItem(keys.pending);
  if (pending) {
    material = JSON.parse(pending) as CredentialRequestMaterial;
  } else {
    material = await createCredentialRequest(credentialPublicKeyJwk, chainId, electionId);
    localStorage.setItem(keys.pending, JSON.stringify(material));
  }

  const registrar = new RegistrarClient(REGISTRAR_URL);
  let result;
  try {
    result = await registrar.requestCredential(code, electionId, material.blindedToken);
  } catch (e) {
    return { status: 'error', message: `registrar unreachable: ${(e as Error).message}` };
  }

  switch (result.status) {
    case 'ok': {
      const credentialSig = await finalizeCredential(credentialPublicKeyJwk, material, result.blindSignature);
      // Trust nothing: verify the finished credential before storing it.
      const valid = await verifyCredential(
        credentialPublicKeyJwk,
        chainId,
        electionId,
        material.token,
        material.tokenPrefix,
        credentialSig,
      );
      if (!valid) {
        return { status: 'error', message: 'the registrar returned an invalid credential. Contact the commission.' };
      }
      const credential: StoredCredential = {
        electionId,
        token: material.token,
        tokenSecretKey: material.tokenSecretKey,
        tokenPrefix: material.tokenPrefix,
        credentialSig,
      };
      localStorage.setItem(keys.cred, JSON.stringify(credential));
      localStorage.removeItem(keys.pending);
      return { status: 'ok', credential };
    }
    case 'already_issued':
      // A credential exists but was requested with different material (another
      // device, or this device's storage was cleared). Our material is useless.
      localStorage.removeItem(keys.pending);
      return { status: 'already_issued' };
    case 'unknown_election':
      return { status: 'error', message: 'the registrar does not recognize this election yet. Try again shortly.' };
    case 'unknown_code':
    case 'code_revoked':
      return { status: result.status, message: result.message };
    default:
      return { status: 'error', message: result.message };
  }
}
