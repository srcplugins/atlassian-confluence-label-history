import React, { useEffect, useRef, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  DynamicTable,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  User,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { PublicResponseError, isRecord } from './shared/response.mjs';
import { readHistory, readRestore, restorable, type Change } from './client';

// Dates follow the viewer's Confluence language and time zone, set once the product context loads.
let dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function setConfluenceDates(locale: unknown, timeZone: unknown) {
  try {
    const language = typeof locale === 'string' && locale ? locale.replace('_', '-') : undefined;
    dateFormat = new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(typeof timeZone === 'string' && timeZone ? { timeZone } : {}),
    });
  } catch {
    // An unknown language or zone keeps the browser's.
  }
}
const when = (at: string) => dateFormat.format(new Date(at));

// A refusal or a busy answer carries its own guidance; anything else is a lost connection.
const failure = (error: unknown) =>
  error instanceof PublicResponseError ? error.message : 'Connection failed. Try again.';

const actionLozenge = (action: Change['action']) =>
  action === 'added' ? (
    <Lozenge appearance="success">Added</Lozenge>
  ) : (
    <Lozenge appearance="removed">Removed</Lozenge>
  );
const actor = (id: string | null) => (id ? <User accountId={id} /> : <Text>Unknown</Text>);

/** A failed read, with Try again for every cause: access and busy sites change, too. */
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <SectionMessage appearance="error" title="Label history couldn't load">
      <Text>{message}</Text>
      <Button autoFocus onClick={retry}>
        Try again
      </Button>
    </SectionMessage>
  );
}

type Restore =
  | { label: string; step: 'confirm' | 'sending' | 'done' | 'unconfirmed' }
  | { label: string; step: 'failed'; message: string };

/**
 * The restore's confirmation and outcome. The confirmation names the label, and its button keeps
 * focus while the label is added, once; each outcome's Close button takes focus.
 */
function RestoreMessage({
  restore,
  confirm,
  close,
}: {
  restore: Restore;
  confirm: () => void;
  close: () => void;
}) {
  const closeButton = (
    <Button autoFocus onClick={close}>
      Close
    </Button>
  );
  if (restore.step === 'done')
    return (
      <SectionMessage appearance="success" title={`Label "${restore.label}" restored`}>
        {closeButton}
      </SectionMessage>
    );
  if (restore.step === 'unconfirmed')
    return (
      <SectionMessage
        appearance="warning"
        title={`Restoring label "${restore.label}" wasn't confirmed`}
      >
        <Text>
          Confluence didn&apos;t confirm the change. Reopen the history to see whether the label was
          restored.
        </Text>
        {closeButton}
      </SectionMessage>
    );
  if (restore.step === 'failed')
    return (
      <SectionMessage appearance="error" title={`Label "${restore.label}" wasn't restored`}>
        <Text>{restore.message}</Text>
        {closeButton}
      </SectionMessage>
    );
  return (
    <SectionMessage appearance="information" title={`Restore label "${restore.label}"?`}>
      <Text>The label will be visible to anyone with access to this page.</Text>
      <ButtonGroup label="Restore">
        <LoadingButton
          appearance="primary"
          autoFocus
          isLoading={restore.step === 'sending'}
          onClick={confirm}
        >
          Restore label
        </LoadingButton>
        <Button isDisabled={restore.step === 'sending'} onClick={close}>
          Cancel
        </Button>
      </ButtonGroup>
    </SectionMessage>
  );
}

// After a restore, the history is reread this often, this many times, until Confluence's label
// event for it is recorded (usually within a few seconds).
const recheckMs = 2000;
const rechecks = 10;

/** A label whose restore is awaited, and the time of its newest change when the restore was sent. */
interface Awaited {
  label: string;
  after: number;
}

/** The label's newest recorded change. */
const newest = (changes: Change[], label: string) => changes.find((c) => c.label === label);

/** The label's newest change, if it is newer than when the restore was sent. */
const since = (changes: Change[], { label, after }: Awaited) => {
  const change = newest(changes, label);
  return change && Date.parse(change.at) > after ? change : undefined;
};

/** One page's label changes, newest first, in the popup under the page's title. */
function PageHistory({ pageId, accountId }: { pageId: string; accountId: string | null }) {
  const [state, setState] = useState<{
    value?: ReturnType<typeof readHistory>;
    error?: string;
  }>({});
  const [round, setRound] = useState(0);
  const [restore, setRestore] = useState<Restore>();
  // Restores Confluence confirmed in this popup, shown at once until a newer change to their label
  // is recorded.
  const [pending, setPending] = useState<Change[]>([]);
  // Restores awaited in the history, confirmed or not. A reread's answer is matched against the list
  // as it is when the answer arrives, so `awaited` holds it alongside the state that schedules rereads.
  const [awaiting, setAwaiting] = useState<Awaited[]>([]);
  const awaited = useRef<Awaited[]>([]);
  const updateAwaiting = (update: (list: Awaited[]) => Awaited[]) => {
    awaited.current = update(awaited.current);
    setAwaiting(awaited.current);
  };
  const [recheck, setRecheck] = useState(0);
  // Only the latest history read may set the result, and one restore is sent at a time: a loading
  // button still accepts clicks.
  const latest = useRef(0);
  const sending = useRef(false);
  useEffect(() => {
    const n = ++latest.current;
    setState({});
    invoke<unknown>('history', { pageId })
      .then((response) => n === latest.current && setState({ value: readHistory(response) }))
      .catch((error: unknown) => n === latest.current && setState({ error: failure(error) }));
  }, [pageId, round]);
  // While the table shows, rereads quietly until each awaited label has a newer recorded change: then
  // its pending row goes, and an unconfirmed restore whose label was added back shows as restored.
  // Each reread counts, whatever its outcome: rereads stop after `rechecks`. A lost call keeps the
  // table; a failure the app reports replaces it with its message and Try again.
  const shown = Boolean(state.value);
  useEffect(() => {
    if (!shown || !awaiting.length || recheck >= rechecks) return;
    const timer = setTimeout(() => {
      const n = ++latest.current;
      invoke<unknown>('history', { pageId })
        .then((response) => {
          if (n !== latest.current) return;
          const value = readHistory(response);
          const done = awaited.current.filter((a) => since(value.changes, a));
          const added = (label: string) =>
            done.some((a) => a.label === label && since(value.changes, a)?.action === 'added');
          setState({ value });
          setPending((list) => list.filter((p) => !done.some((a) => a.label === p.label)));
          setRestore((r) =>
            r?.step === 'unconfirmed' && added(r.label) ? { label: r.label, step: 'done' } : r,
          );
          updateAwaiting((list) => list.filter((a) => !done.includes(a)));
        })
        .catch((error: unknown) => {
          if (n !== latest.current || !(error instanceof PublicResponseError)) return;
          updateAwaiting(() => []);
          setPending([]);
          setState({ error: failure(error) });
        })
        .finally(() => n === latest.current && setRecheck((k) => k + 1));
    }, recheckMs);
    return () => clearTimeout(timer);
  }, [pageId, shown, awaiting, recheck]);
  if (state.error) return <Failure message={state.error} retry={() => setRound((r) => r + 1)} />;
  if (!state.value) return <Spinner label="Loading label history" />;
  const { page, older, canEdit } = state.value;
  const changes = [...pending, ...state.value.changes];
  if (!changes.length) return <Text>No label changes recorded for this page yet.</Text>;
  const undoable = restorable(changes);
  const busy = restore?.step === 'sending';
  const recorded = state.value.changes;
  const watch = (label: string) => {
    const change = newest(recorded, label);
    const after = change ? Date.parse(change.at) : 0;
    updateAwaiting((list) => [...list.filter((a) => a.label !== label), { label, after }]);
    setRecheck(0);
  };
  const confirm = () => {
    if (sending.current || restore?.step !== 'confirm') return;
    sending.current = true;
    const { label } = restore;
    setRestore({ label, step: 'sending' });
    invoke<unknown>('restore', { pageId: page.id, label })
      .then((response) => {
        const { confirmed } = readRestore(response);
        if (confirmed)
          setPending((list) => [
            { at: new Date().toISOString(), action: 'added', label, actor: accountId },
            ...list,
          ]);
        watch(label);
        setRestore({ label, step: confirmed ? 'done' : 'unconfirmed' });
      })
      .catch((error: unknown) => {
        // Confluence refused: nothing changed. Otherwise the label may have been added.
        if (error instanceof PublicResponseError)
          setRestore({ label, step: 'failed', message: error.message });
        else {
          watch(label);
          setRestore({ label, step: 'unconfirmed' });
        }
      })
      .finally(() => {
        sending.current = false;
      });
  };
  const restoreCell = (c: Change, i: number) =>
    undoable[i] ? (
      <Button isDisabled={busy} onClick={() => setRestore({ label: c.label, step: 'confirm' })}>
        Restore
      </Button>
    ) : null;
  // A restore whose change Confluence hasn't sent by the last reread says so instead of a time.
  const whenCell = (c: Change, i: number) =>
    i < pending.length && recheck >= rechecks ? 'Not recorded yet' : when(c.at);
  return (
    <Stack space="space.200">
      {older ? <Text>The latest 100 changes. Older ones aren't kept.</Text> : null}
      {restore ? (
        <RestoreMessage restore={restore} confirm={confirm} close={() => setRestore(undefined)} />
      ) : null}
      <DynamicTable
        caption="Label changes"
        head={{
          cells: [
            { key: 'when', content: 'When' },
            { key: 'change', content: 'Change' },
            { key: 'label', content: 'Label' },
            { key: 'actor', content: 'Changed by' },
            ...(canEdit ? [{ key: 'restore', content: 'Action' }] : []),
          ],
        }}
        rows={changes.map((c, i) => ({
          key: `${i}`,
          cells: [
            { key: 'when', content: whenCell(c, i) },
            { key: 'change', content: actionLozenge(c.action) },
            { key: 'label', content: c.label },
            { key: 'actor', content: actor(c.actor) },
            ...(canEdit ? [{ key: 'restore', content: restoreCell(c, i) }] : []),
          ],
        }))}
        rowsPerPage={25}
      />
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  useEffect(() => {
    if (context) setConfluenceDates(context.locale, context.timezone);
  }, [context]);
  if (!context) return <Spinner label="Loading" />;
  // The byline item is the app's only screen; its context names the page.
  const content =
    isRecord(context.extension) && isRecord(context.extension.content)
      ? context.extension.content
      : {};
  // A live doc is a page with a subtype; its labels aren't recorded.
  if (content.type !== 'page' || content.subtype || typeof content.id !== 'string')
    return <Text>Label History records page labels only.</Text>;
  return (
    <PageHistory
      pageId={content.id}
      accountId={typeof context.accountId === 'string' ? context.accountId : null}
    />
  );
}
ForgeReconciler.render(<App />);
