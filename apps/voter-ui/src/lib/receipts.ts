import type { Receipt } from '@votechain/protocol';

const KEY = 'vc:receipts';

export function listReceipts(): Receipt[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Receipt[]) : [];
  } catch {
    return [];
  }
}

export function saveReceipt(receipt: Receipt): void {
  const receipts = listReceipts().filter((r) => r.txHash !== receipt.txHash);
  receipts.push(receipt);
  localStorage.setItem(KEY, JSON.stringify(receipts));
}

export function receiptForToken(electionId: string, token: string): Receipt | undefined {
  return listReceipts()
    .filter((r) => r.electionId === electionId && r.token === token)
    .sort((a, b) => b.castAt - a.castAt)[0];
}

/**
 * Newest receipt for an election, whatever token cast it.
 *
 * This is what lets the receipt screen be addressed as `#/receipt/:electionId`
 * rather than by token. The token is public, but a URL carrying it would be
 * copied into browser history and profile sync; the election id gives away
 * nothing that the record does not already publish.
 */
export function latestReceiptFor(electionId: string): Receipt | undefined {
  return listReceipts()
    .filter((r) => r.electionId === electionId)
    .sort((a, b) => b.castAt - a.castAt)[0];
}

export function downloadReceipt(receipt: Receipt): void {
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `plainvote-receipt-${receipt.electionId.slice(0, 8)}-${receipt.castAt}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
