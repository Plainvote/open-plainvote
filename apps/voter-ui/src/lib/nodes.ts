import { allNodeClients as allClients, pickHealthyNode as pick, type HealthyNode } from '@plainvote/ui';
import { NODE_URLS } from './config';

/**
 * This app's record-keepers, bound to the shared selection logic.
 *
 * The implementation moved to @plainvote/ui: there were two of them and they
 * had drifted, with only the results app having a probe timeout. That gap was
 * worst here, where a record-keeper that accepts a connection and then goes
 * quiet would have left a voter waiting mid-ballot.
 */
export type { HealthyNode };

export function pickHealthyNode(): Promise<HealthyNode> {
  return pick(NODE_URLS);
}

/** Every record-keeper: a ballot goes to all of them, never just one. */
export function allNodeClients() {
  return allClients(NODE_URLS);
}
