import { useMemo, useState } from 'react';
import { ed25519PublicKeyFromSecret } from '@votechain/protocol';
import { useApp } from '../App';
import { DEFAULT_NODE_URLS, errorMessage, makeNodeClient, makeRegistrarClient } from '../lib/settings';

type ServiceCheck = { state: 'ok'; summary: string } | { state: 'error'; summary: string };

interface TestResults {
  node: ServiceCheck;
  registrar: ServiceCheck;
}

type DerivedKey = { valid: true; publicKey: string } | { valid: false } | null;

export function SetupTab() {
  const { settings, updateSettings } = useApp();
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResults | null>(null);

  const derivedKey = useMemo<DerivedKey>(() => {
    const secret = settings.commissionSecretKey.trim();
    if (secret.length === 0) return null;
    try {
      return { valid: true, publicKey: ed25519PublicKeyFromSecret(secret) };
    } catch {
      return { valid: false };
    }
  }, [settings.commissionSecretKey]);

  async function testConnections() {
    setTesting(true);
    setResults(null);
    const nodeCheck = (async (): Promise<ServiceCheck> => {
      const status = await makeNodeClient(settings).status();
      return {
        state: 'ok',
        summary: `Record-keeper OK: record ${status.chainId.slice(0, 16)}…, ${status.height} pages written (${status.nodeName})`,
      };
    })().catch((e: unknown): ServiceCheck => ({ state: 'error', summary: `Record-keeper: ${errorMessage(e)}` }));
    const registrarCheck = (async (): Promise<ServiceCheck> => {
      const stats = await makeRegistrarClient(settings).stats();
      return {
        state: 'ok',
        summary: `Registrar OK: ${stats.activeCodes} active code(s), ${stats.revokedCodes} revoked, issuance tracked for ${stats.elections.length} election(s)`,
      };
    })().catch((e: unknown): ServiceCheck => ({ state: 'error', summary: `Registrar: ${errorMessage(e)}` }));
    const [node, registrar] = await Promise.all([nodeCheck, registrarCheck]);
    setResults({ node, registrar });
    setTesting(false);
  }

  return (
    <section>
      <div className="card">
        <h2>Connection settings</h2>
        <div className="notice warn">
          Demo key handling: everything on this page, including the registrar admin key and the commission
          signing key, is stored unencrypted in this browser's localStorage. A production commission would
          keep signing keys in an HSM, never in a browser.
        </div>
        <div className="grid two">
          <div>
            <label htmlFor="setup-node-url">Record-keeper URL</label>
            <input
              id="setup-node-url"
              type="text"
              value={settings.nodeUrl}
              onChange={(e) => updateSettings({ nodeUrl: e.target.value })}
              placeholder="http://127.0.0.1:4001"
            />
            <p className="hint">
              Known record-keepers: {DEFAULT_NODE_URLS.join(', ')}. Switch if the first one is down.
            </p>
          </div>
          <div>
            <label htmlFor="setup-registrar-url">Registrar URL</label>
            <input
              id="setup-registrar-url"
              type="text"
              value={settings.registrarUrl}
              onChange={(e) => updateSettings({ registrarUrl: e.target.value })}
              placeholder="http://127.0.0.1:5001"
            />
            <p className="hint">The registrar issues voter codes and blind credentials.</p>
          </div>
          <div>
            <label htmlFor="setup-admin-key">Registrar admin key</label>
            <input
              id="setup-admin-key"
              type="password"
              value={settings.registrarAdminKey}
              onChange={(e) => updateSettings({ registrarAdminKey: e.target.value })}
              autoComplete="off"
            />
            <p className="hint">Sent as the x-admin-key header on registrar admin endpoints.</p>
          </div>
          <div>
            <label htmlFor="setup-secret-key">Commission secret key</label>
            <input
              id="setup-secret-key"
              type="password"
              value={settings.commissionSecretKey}
              onChange={(e) => updateSettings({ commissionSecretKey: e.target.value })}
              autoComplete="off"
            />
            <p className="hint">Base64url Ed25519 secret key; signs opening and cancelling elections.</p>
          </div>
        </div>
        {derivedKey !== null && derivedKey.valid && (
          <>
            <label>Derived commission public key</label>
            <code className="mono-block">{derivedKey.publicKey}</code>
            <p className="hint">
              Must match the commission public key fixed when this record was founded, or the record-keepers will
              reject your signatures.
            </p>
          </>
        )}
        {derivedKey !== null && !derivedKey.valid && (
          <div className="notice danger">
            The commission secret key is not a valid base64url Ed25519 secret key. Check it for typos or
            missing characters.
          </div>
        )}
        <div className="row actions-row">
          <button type="button" className="btn" onClick={() => void testConnections()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connections'}
          </button>
        </div>
        {results && (
          <>
            <div className={`notice ${results.node.state === 'ok' ? 'ok' : 'danger'}`}>{results.node.summary}</div>
            <div className={`notice ${results.registrar.state === 'ok' ? 'ok' : 'danger'}`}>
              {results.registrar.summary}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
