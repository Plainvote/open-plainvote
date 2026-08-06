import type {
  Block,
  CodeInfo,
  CredentialResult,
  ElectionDetail,
  ElectionKeysResponse,
  ElectionSummary,
  NodeStatusInfo,
  RegistrarStats,
  ResultsResponse,
  ReturnCodeLookup,
  ReturnCodeSheet,
  SubmitTxResult,
  Tx,
  TxLookupResponse,
  VoteLookupResponse,
} from './types';

/** Thrown for unexpected HTTP failures (expected outcomes get typed results). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status} from ${url}`;
    throw new HttpError(res.status, body, message);
  }
  return body as T;
}

function post(bodyValue: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(bodyValue),
  };
}

// ---------------------------------------------------------------------------

export class NodeClient {
  constructor(readonly baseUrl: string) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, '') + path;
  }

  status(): Promise<NodeStatusInfo> {
    return request(this.url('/status'));
  }

  blocks(from?: number, limit?: number): Promise<{ blocks: Block[] }> {
    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', String(from));
    if (limit !== undefined) params.set('limit', String(limit));
    const qs = params.toString();
    return request(this.url('/blocks' + (qs ? `?${qs}` : '')));
  }

  block(height: number): Promise<Block> {
    return request(this.url(`/blocks/${height}`));
  }

  transaction(hash: string): Promise<TxLookupResponse> {
    return request(this.url(`/transactions/${hash}`));
  }

  elections(): Promise<{ elections: ElectionSummary[] }> {
    return request(this.url('/elections'));
  }

  election(electionId: string): Promise<ElectionDetail> {
    return request(this.url(`/elections/${encodeURIComponent(electionId)}`));
  }

  results(electionId: string): Promise<ResultsResponse> {
    return request(this.url(`/elections/${encodeURIComponent(electionId)}/results`));
  }

  voteLookup(electionId: string, token: string): Promise<VoteLookupResponse> {
    return request(this.url(`/elections/${encodeURIComponent(electionId)}/votes/${encodeURIComponent(token)}`));
  }

  /** Submit a transaction; rejections come back as {accepted:false, reason}. */
  async submitTx(tx: Tx): Promise<SubmitTxResult> {
    try {
      return await request<SubmitTxResult>(this.url('/transactions'), post({ tx }));
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 409)) {
        const body = e.body as Partial<SubmitTxResult> | null;
        return { accepted: false, reason: body?.reason ?? e.message };
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------

export class RegistrarClient {
  constructor(
    readonly baseUrl: string,
    private readonly adminKey?: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, '') + path;
  }

  private adminHeaders(): Record<string, string> {
    if (!this.adminKey) throw new Error('RegistrarClient: adminKey required for admin endpoints');
    return { 'x-admin-key': this.adminKey };
  }

  /** Request a blind signature over a blinded token. Expected failures are typed. */
  async requestCredential(code: string, electionId: string, blindedToken: string): Promise<CredentialResult> {
    try {
      const res = await request<{ blindSignature: string }>(
        this.url('/credentials'),
        post({ code, electionId, blindedToken }),
      );
      return { status: 'ok', blindSignature: res.blindSignature };
    } catch (e) {
      if (e instanceof HttpError) {
        const body = e.body as { error?: string; message?: string } | null;
        const error = body?.error;
        if (
          error === 'unknown_code' ||
          error === 'unknown_election' ||
          error === 'code_revoked' ||
          error === 'already_issued' ||
          error === 'code_not_in_roll' ||
          error === 'roll_not_bound'
        ) {
          return { status: error, message: body?.message ?? error };
        }
      }
      throw e;
    }
  }

  /** Generate codes, optionally scoped to a voter roll. Plaintext codes come back once. */
  generateCodes(count: number, rollId?: string): Promise<{ codes: string[] }> {
    const body = rollId === undefined ? { count } : { count, rollId };
    return request(this.url('/admin/codes'), post(body, this.adminHeaders()));
  }

  listCodes(rollId?: string): Promise<{ codes: CodeInfo[] }> {
    const qs = rollId === undefined ? '' : `?rollId=${encodeURIComponent(rollId)}`;
    return request(this.url('/admin/codes' + qs), { headers: this.adminHeaders() });
  }

  /** Restrict an election's electorate to one voter roll. Idempotent per roll. */
  bindElectionRoll(electionId: string, rollId: string): Promise<{ electionId: string; rollId: string; bound: boolean }> {
    return request(
      this.url(`/admin/elections/${encodeURIComponent(electionId)}/roll`),
      post({ rollId }, this.adminHeaders()),
    );
  }

  electionRoll(electionId: string): Promise<{ electionId: string; rollId: string | null }> {
    return request(this.url(`/admin/elections/${encodeURIComponent(electionId)}/roll`), {
      headers: this.adminHeaders(),
    });
  }

  revokeCode(codeHash: string): Promise<{ ok: boolean }> {
    return request(this.url('/admin/codes/revoke'), post({ codeHash }, this.adminHeaders()));
  }

  regenerateCode(codeHash: string): Promise<{ code: string }> {
    return request(this.url('/admin/codes/regenerate'), post({ codeHash }, this.adminHeaders()));
  }

  createElectionKeys(electionId: string): Promise<ElectionKeysResponse> {
    return request(this.url(`/admin/elections/${encodeURIComponent(electionId)}/keys`), post({}, this.adminHeaders()));
  }

  commitIssuance(electionId: string): Promise<{ txHash: string; issuedCount: number; resetCount: number; accepted: boolean }> {
    return request(this.url(`/admin/elections/${encodeURIComponent(electionId)}/commit`), post({}, this.adminHeaders()));
  }

  resetIssuance(codeHash: string, electionId: string): Promise<{ ok: boolean; resetCount: number }> {
    return request(this.url('/admin/issuance/reset'), post({ codeHash, electionId }, this.adminHeaders()));
  }

  stats(): Promise<RegistrarStats> {
    return request(this.url('/admin/stats'), { headers: this.adminHeaders() });
  }

  /** Admin: generate `count` return-code sheets for an election (shown once). */
  generateReturnCodeSheets(electionId: string, count: number): Promise<{ sheets: ReturnCodeSheet[] }> {
    return request(
      this.url(`/admin/elections/${encodeURIComponent(electionId)}/return-codes`),
      post({ count }, this.adminHeaders()),
    );
  }

  /** Public: retrieve the return code(s) for the ballot recorded under `token`. */
  getReturnCodes(electionId: string, sheetId: string, token: string): Promise<ReturnCodeLookup> {
    return request(this.url('/return-codes'), post({ electionId, sheetId, token }));
  }
}
