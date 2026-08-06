import { useState } from 'react';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_ELIGIBLE_COUNT,
  MAX_OPTIONS_PER_QUESTION,
  MAX_OPTION_LENGTH,
  MAX_QUESTIONS,
  MAX_QUESTION_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_OPTIONS_PER_QUESTION,
  buildElectionCreateTx,
  electionDefinitionError,
} from '@votechain/protocol';
import type {
  ElectionDefinition,
  ElectionDetail,
  ElectionKeysResponse,
  NodeClient,
  ResultsVisibility,
} from '@votechain/protocol';
import { useApp } from '../App';
import {
  errorMessage,
  makeNodeClient,
  makeRegistrarClient,
  resultsAppElectionUrl,
} from '../lib/settings';

interface OptionDraft {
  id: string;
  text: string;
}

interface QuestionDraft {
  id: string;
  text: string;
  options: OptionDraft[];
}

type StepState = 'running' | 'ok' | 'warn' | 'error';

interface StepLine {
  id: string;
  text: string;
  state: StepState;
}

function newOption(): OptionDraft {
  return { id: crypto.randomUUID(), text: '' };
}

function newQuestion(): QuestionDraft {
  return { id: crypto.randomUUID(), text: '', options: [newOption(), newOption()] };
}

/** Format a ms timestamp as a datetime-local input value (local time). */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Consensus requires NFC-normalized strings; normalize every user input. */
function nfcTrim(value: string): string {
  return value.trim().normalize('NFC');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sentinel: the flow already recorded its own error in the step list. */
class FlowHalted extends Error {}

/** Poll until the election shows up in the record (404 until it is written down). */
async function waitForElection(
  node: NodeClient,
  electionId: string,
  timeoutMs: number,
): Promise<ElectionDetail | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await node.election(electionId);
    } catch {
      // 404 until a record-keeper writes it down; transient errors are retried too.
    }
    if (Date.now() > deadline) return null;
    await sleep(2000);
  }
}

export function CreateElectionWizard({ onClose }: { onClose: () => void }) {
  const { settings } = useApp();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState(() => toLocalInputValue(Date.now() + 10 * 60_000));
  const [end, setEnd] = useState(() => toLocalInputValue(Date.now() + 70 * 60_000));
  const [visibility, setVisibility] = useState<ResultsVisibility>('afterClose');
  const [allowRevote, setAllowRevote] = useState(true);
  const [eligibleCount, setEligibleCount] = useState('');
  const [questions, setQuestions] = useState<QuestionDraft[]>(() => [newQuestion()]);

  const [fetchingCount, setFetchingCount] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepLine[]>([]);
  const [created, setCreated] = useState<{ electionId: string; title: string; pending: boolean } | null>(null);

  // --- question builder operations -----------------------------------------

  const setQuestionText = (qid: string, text: string) =>
    setQuestions((prev) => prev.map((q) => (q.id === qid ? { ...q, text } : q)));
  const setOptionText = (qid: string, oid: string, text: string) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qid ? { ...q, options: q.options.map((o) => (o.id === oid ? { ...o, text } : o)) } : q,
      ),
    );
  const addQuestion = () => setQuestions((prev) => [...prev, newQuestion()]);
  const removeQuestion = (qid: string) => setQuestions((prev) => prev.filter((q) => q.id !== qid));
  const addOption = (qid: string) =>
    setQuestions((prev) => prev.map((q) => (q.id === qid ? { ...q, options: [...q.options, newOption()] } : q)));
  const removeOption = (qid: string, oid: string) =>
    setQuestions((prev) =>
      prev.map((q) => (q.id === qid ? { ...q, options: q.options.filter((o) => o.id !== oid) } : q)),
    );

  // --- step list helpers ----------------------------------------------------

  function pushStep(id: string, text: string, state: StepState) {
    setSteps((prev) => [...prev, { id, text, state }]);
  }
  function updateStep(id: string, text: string, state: StepState) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { id, text, state } : s)));
  }
  function failRunningStep(message: string) {
    setSteps((prev) =>
      prev.map((s) => (s.state === 'running' ? { ...s, state: 'error', text: `${s.text} ${message}` } : s)),
    );
  }

  // --- validation and assembly ----------------------------------------------

  function precheck(): string | null {
    const t = nfcTrim(title);
    if (t.length === 0) return 'Title is required.';
    if (t.length > MAX_TITLE_LENGTH) return `Title exceeds ${MAX_TITLE_LENGTH} characters.`;
    if (nfcTrim(description).length > MAX_DESCRIPTION_LENGTH) {
      return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
    }
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!Number.isFinite(startMs)) return 'Start time is required.';
    if (!Number.isFinite(endMs)) return 'End time is required.';
    if (startMs >= endMs) return 'Start time must be before end time.';
    const count = Number(eligibleCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_ELIGIBLE_COUNT) {
      return `Eligible voter count must be an integer between 1 and ${MAX_ELIGIBLE_COUNT}.`;
    }
    for (const [index, q] of questions.entries()) {
      const qText = nfcTrim(q.text);
      if (qText.length === 0) return `Question ${index + 1} needs text.`;
      if (qText.length > MAX_QUESTION_LENGTH) {
        return `Question ${index + 1} text exceeds ${MAX_QUESTION_LENGTH} characters.`;
      }
      const seenLabels = new Set<string>();
      for (const o of q.options) {
        const oText = nfcTrim(o.text);
        if (oText.length === 0) return `Question ${index + 1} has an empty option.`;
        if (oText.length > MAX_OPTION_LENGTH) {
          return `An option in question ${index + 1} exceeds ${MAX_OPTION_LENGTH} characters.`;
        }
        const label = oText.toLowerCase();
        if (seenLabels.has(label)) {
          return `Question ${index + 1} has two options with the same label ("${oText}").`;
        }
        seenLabels.add(label);
      }
    }
    return null;
  }

  function assembleDefinition(electionId: string, keys: ElectionKeysResponse): ElectionDefinition {
    const desc = nfcTrim(description);
    return {
      electionId,
      title: nfcTrim(title),
      // Canonical serialization rejects undefined values — omit the key entirely
      // when there is no description.
      ...(desc.length > 0 ? { description: desc } : {}),
      questions: questions.map((q) => ({
        id: q.id,
        text: nfcTrim(q.text),
        options: q.options.map((o) => ({ id: o.id, text: nfcTrim(o.text) })),
      })),
      startTime: new Date(start).getTime(),
      endTime: new Date(end).getTime(),
      resultsVisibility: visibility,
      allowRevote,
      eligibleCount: Math.trunc(Number(eligibleCount)),
      credentialPublicKeyJwk: keys.publicKeyJwk,
      registrarKeyAttestationSig: keys.attestationSig,
    };
  }

  // --- actions ----------------------------------------------------------------

  async function fillEligibleCount() {
    setFetchingCount(true);
    setFormError(null);
    try {
      const stats = await makeRegistrarClient(settings).stats();
      setEligibleCount(String(stats.activeCodes));
    } catch (e) {
      setFormError(`Could not read registrar stats: ${errorMessage(e)}`);
    } finally {
      setFetchingCount(false);
    }
  }

  async function createElection() {
    setFormError(null);
    setCreated(null);
    setSteps([]);
    const problem = precheck();
    if (problem) {
      setFormError(problem);
      return;
    }
    setSubmitting(true);
    const electionId = crypto.randomUUID();
    let keysIssued = false;
    try {
      pushStep('keys', 'Step 1: requesting a per-election credential key from the registrar…', 'running');
      const keys = await makeRegistrarClient(settings).createElectionKeys(electionId);
      keysIssued = true;
      updateStep('keys', 'Step 1: registrar created the election credential key and attestation.', 'ok');

      pushStep('validate', 'Step 2: assembling and validating the election definition…', 'running');
      const definition = assembleDefinition(electionId, keys);
      const defErr = electionDefinitionError(definition);
      if (defErr) {
        updateStep('validate', `Step 2: definition rejected before signing: ${defErr}`, 'error');
        throw new FlowHalted();
      }
      updateStep('validate', 'Step 2: definition passed consensus validation.', 'ok');

      pushStep('submit', 'Step 3: signing the election and sending it to a record-keeper…', 'running');
      const node = makeNodeClient(settings);
      const status = await node.status();
      const tx = buildElectionCreateTx(status.chainId, definition, settings.commissionSecretKey.trim());
      const result = await node.submitTx(tx);
      if (!result.accepted) {
        updateStep('submit', `Step 3: the record-keeper refused it: ${result.reason ?? 'no reason given'}`, 'error');
        throw new FlowHalted();
      }
      updateStep('submit', `Step 3: accepted (entry ${result.txHash ?? 'unknown'}).`, 'ok');

      pushStep('confirm', 'Step 4: waiting for the election to appear in the public record (up to 30 s)…', 'running');
      const detail = await waitForElection(node, electionId, 30_000);
      if (detail) {
        updateStep('confirm', `Step 4: the election is in the public record (page ${detail.createdAtHeight}).`, 'ok');
        setCreated({ electionId, title: definition.title, pending: false });
      } else {
        updateStep(
          'confirm',
          'Step 4: it was accepted but the election has not appeared after 30 s. It usually shows up shortly; check the Elections tab.',
          'warn',
        );
        setCreated({ electionId, title: definition.title, pending: true });
      }
    } catch (e) {
      if (!(e instanceof FlowHalted)) {
        failRunningStep(`failed: ${errorMessage(e)}`);
      }
      if (keysIssued) {
        pushStep(
          'note',
          `Note: the registrar already created credential keys for election id ${electionId}. Keys are one-per-election, so retrying will start over with a fresh election id (this happens automatically on the next attempt).`,
          'warn',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const busyAny = submitting || fetchingCount;

  return (
    <section>
      <div className="card">
        <div className="spread">
          <h2>New election</h2>
          <button type="button" className="btn secondary small" onClick={onClose} disabled={submitting}>
            Back to elections
          </button>
        </div>

        <fieldset className="bare" disabled={submitting || created !== null}>
          <label htmlFor="el-title">Title</label>
          <input
            id="el-title"
            type="text"
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Board election 2026"
          />

          <label htmlFor="el-description">Description (optional)</label>
          <textarea
            id="el-description"
            rows={3}
            value={description}
            maxLength={MAX_DESCRIPTION_LENGTH}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Shown to voters on the ballot."
          />

          <div className="grid two">
            <div>
              <label htmlFor="el-start">Start time</label>
              <input id="el-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <label htmlFor="el-end">End time</label>
              <input id="el-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>

          <div className="grid two">
            <div>
              <label htmlFor="el-visibility">Results visibility</label>
              <select
                id="el-visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value === 'live' ? 'live' : 'afterClose')}
              >
                <option value="afterClose">After close (recommended)</option>
                <option value="live">Live</option>
              </select>
              <p className="hint">
                Live tallies can influence voters who have not voted yet. Note that in v1, hiding results until
                close is a convention honest record-keepers follow, not cryptography, since the ballots
                themselves are public either way.
              </p>
            </div>
            <div>
              <label htmlFor="el-eligible">Eligible voters</label>
              <div className="row">
                <input
                  id="el-eligible"
                  type="number"
                  min={1}
                  max={MAX_ELIGIBLE_COUNT}
                  className="flex-input"
                  value={eligibleCount}
                  onChange={(e) => setEligibleCount(e.target.value)}
                  placeholder="e.g. 25"
                />
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => void fillEligibleCount()}
                  disabled={fetchingCount}
                >
                  {fetchingCount ? 'Fetching…' : 'Use registered-code count'}
                </button>
              </div>
              <p className="hint">
                Public size of the voter roll. Turnout above this number is a visible red flag for observers.
              </p>
            </div>
          </div>

          <label className="check">
            <input type="checkbox" checked={allowRevote} onChange={(e) => setAllowRevote(e.target.checked)} />
            Allow revoting
          </label>
          <p className="hint">
            Lets a coerced voter override their ballot later; only the last counted vote is tallied.
          </p>

          <h3>Questions</h3>
          {questions.map((q, qIndex) => (
            <div className="card question-card" key={q.id}>
              <div className="spread">
                <strong>Question {qIndex + 1}</strong>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={questions.length <= 1}
                  onClick={() => removeQuestion(q.id)}
                >
                  Remove question
                </button>
              </div>
              <label htmlFor={`q-${q.id}`}>Question text</label>
              <input
                id={`q-${q.id}`}
                type="text"
                value={q.text}
                maxLength={MAX_QUESTION_LENGTH}
                onChange={(e) => setQuestionText(q.id, e.target.value)}
                placeholder="e.g. Who should chair the committee?"
              />
              <label>Options (minimum {MIN_OPTIONS_PER_QUESTION})</label>
              <div className="stack">
                {q.options.map((o, oIndex) => (
                  <div className="row" key={o.id}>
                    <input
                      type="text"
                      className="flex-input"
                      value={o.text}
                      maxLength={MAX_OPTION_LENGTH}
                      onChange={(e) => setOptionText(q.id, o.id, e.target.value)}
                      placeholder={`Option ${oIndex + 1}`}
                      aria-label={`Question ${qIndex + 1} option ${oIndex + 1}`}
                    />
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={q.options.length <= MIN_OPTIONS_PER_QUESTION}
                      onClick={() => removeOption(q.id, o.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="row actions-row">
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={q.options.length >= MAX_OPTIONS_PER_QUESTION}
                  onClick={() => addOption(q.id)}
                >
                  Add option
                </button>
              </div>
            </div>
          ))}
          <div className="row">
            <button
              type="button"
              className="btn secondary"
              disabled={questions.length >= MAX_QUESTIONS}
              onClick={addQuestion}
            >
              Add question
            </button>
          </div>
        </fieldset>

        {formError && <div className="notice danger">{formError}</div>}

        <div className="row actions-row">
          <button
            type="button"
            className="btn"
            onClick={() => void createElection()}
            disabled={busyAny || created !== null}
          >
            {submitting ? 'Creating election…' : 'Create election'}
          </button>
        </div>

        {steps.map((s) => (
          <div
            key={s.id}
            className={`notice ${s.state === 'running' ? 'info' : s.state === 'error' ? 'danger' : s.state}`}
          >
            {s.text}
          </div>
        ))}

        {created && (
          <div className={`notice ${created.pending ? 'warn' : 'ok'}`}>
            Election "{created.title}"{' '}
            {created.pending ? 'was submitted and should appear shortly' : 'is live in the public record'}. Election
            id:{' '}
            <code>{created.electionId}</code>.{' '}
            <a href={resultsAppElectionUrl(created.electionId)} target="_blank" rel="noreferrer">
              open the public results page
            </a>{' '}
            or{' '}
            <a
              href="#elections"
              onClick={(event) => {
                event.preventDefault();
                onClose();
              }}
            >
              go back to the elections list
            </a>
            .
          </div>
        )}
      </div>
    </section>
  );
}
