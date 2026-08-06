import { useState } from 'react';
import type { NodeStatusInfo } from '@votechain/protocol';
import { getCode, setCode as rememberCode } from '../lib/session';

export function EnterCode(props: {
  status: NodeStatusInfo | null;
  statusError: string | null;
  onContinue: () => void;
}) {
  /*
   * A code handed off from the emailed link is already in the session by the
   * time this renders (main.tsx takes it out of the URL before React starts),
   * so it is prefilled here. It is still never auto-submitted: the voter sees
   * it and presses Continue, which keeps a misdelivered link visible to
   * whoever is holding it before it is spent.
   */
  const [code, setCodeInput] = useState(() => getCode() ?? '');
  const [handedOff] = useState(() => getCode() !== null);
  const { status, statusError } = props;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length === 0) return;
    rememberCode(code);
    props.onContinue();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Enter the code from your email.</h1>
        <p className="page-lead">
          It proves you are eligible to vote. It is never saved by this app, never published, and never linked to
          how you vote.
        </p>
      </div>

      <div className="card">
        <form onSubmit={submit}>
          <label htmlFor="voter-code">Voter code</label>
          <input
            id="voter-code"
            type="text"
            className="mono"
            placeholder="VC-XXXXX-XXXXX-XXXXX-XXXXX"
            value={code}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            autoCapitalize="characters"
            enterKeyHint="go"
            onChange={(e) => setCodeInput(e.target.value)}
          />
          <p className="hint">Codes are case-insensitive; spaces are ignored.</p>
          {handedOff && (
            <div className="notice ok">
              Your code was filled in from the link you opened. Check it matches the code shown on the
              retrieval page, then continue.
            </div>
          )}
          <div className="row actions-row">
            {/*
              Not gated on the connection check any more. Continue used to be
              disabled until a record-keeper answered, with the reason in a
              different card further down the page, which is the disabled
              button nobody can explain. If the network is unreachable the very
              next screen says so, in words, with somewhere to go.
            */}
            <button className="btn" type="submit" disabled={code.trim().length === 0}>
              Continue
            </button>
          </div>
        </form>
      </div>

      {/*
        The mechanism, folded away.
        This used to be a titled card of four numbered steps about blinding,
        carbon-paper envelopes and RFC 9474, sitting between the voter and the
        thing they came to do. It is a genuine promise and it should be
        readable, so it stays: one line, and open it if you want it. The
        summary alone is the part that matters to almost everyone.
      */}
      <details className="explainer">
        <summary>
          <span>How can this be both anonymous and countable?</span>
        </summary>
        <div className="explainer-body">
          <p>
            Your device makes up a private key for your ballot and asks the registrar to sign it inside a sealed
            envelope. The registrar checks your code is eligible and signs without ever seeing what is inside, so
            it can confirm you may vote without learning which ballot becomes yours.
          </p>
          <p>
            Your ballot is then signed with that key and published to a record kept by several independent
            record-keepers. Anyone can add up every ballot and get the same result. Nobody, including us, can
            trace one back to a person.
          </p>
        </div>
      </details>

      {/*
        The connection reports itself only when it has something a voter can
        act on. It used to be a titled card announcing the chain id, the page
        count and the validator count: instrumentation, given the weight of a
        section heading, on the screen where somebody is trying to find where
        to type their code.
      */}
      {statusError !== null && (
        <div className="notice danger" role="alert">
          We cannot reach the election right now. Check your connection and try again. Your code is still safe to
          use when it comes back.
        </div>
      )}
      {status !== null && (
        <p className="hint">
          Connected. {status.validators.length} independent record-keepers are holding this election.
        </p>
      )}
    </div>
  );
}
