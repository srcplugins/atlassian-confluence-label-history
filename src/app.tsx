import React, { useEffect, useState } from 'react';
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

const failure = (error: unknown) =>
  error instanceof PublicResponseError ? error.message : 'Connection failed. Try again.';

const actionLozenge = (action: Change['action']) =>
  action === 'added' ? (
    <Lozenge appearance="success">Added</Lozenge>
  ) : (
    <Lozenge appearance="removed">Removed</Lozenge>
  );
const actor = (id: string | null) => (id ? <User accountId={id} /> : <Text>Unknown</Text>);

function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <SectionMessage appearance="error" title="Label history couldn't load">
      <Text>{message}</Text>
      {retry ? <Button onClick={retry}>Try again</Button> : null}
    </SectionMessage>
  );
}

type Restore =
  | { label: string; step: 'confirm' | 'sending' }
  | { label: string; step: 'done' }
  | { label: string; step: 'failed'; message: string };

/**
 * The restore's confirmation and outcome. The confirmation names the label and the page, and its
 * button keeps focus while the label is added, once.
 */
function RestoreMessage({
  restore,
  title,
  confirm,
  close,
}: {
  restore: Restore;
  title: string;
  confirm: () => void;
  close: () => void;
}) {
  if (restore.step === 'done')
    return (
      <SectionMessage appearance="success" title={`"${restore.label}" is back on this page`}>
        <Text>It's at the top of the history, under your name.</Text>
        <Button onClick={close}>Close</Button>
      </SectionMessage>
    );
  if (restore.step === 'failed')
    return (
      <SectionMessage appearance="error" title={`"${restore.label}" wasn't restored`}>
        <Text>{restore.message}</Text>
        <Button onClick={close}>Close</Button>
      </SectionMessage>
    );
  return (
    <SectionMessage appearance="information" title={`Add "${restore.label}" back to ${title}?`}>
      <Text>Everyone who can view the page will see the label again.</Text>
      <ButtonGroup label="Restore">
        <LoadingButton
          appearance="primary"
          isLoading={restore.step === 'sending'}
          onClick={confirm}
        >
          Add label back
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

/** One page's label changes, newest first, in the popup under the page's title. */
function PageHistory({ pageId, accountId }: { pageId: string; accountId: string | null }) {
  const [state, setState] = useState<{
    value?: ReturnType<typeof readHistory>;
    error?: string;
  }>({});
  const [round, setRound] = useState(0);
  const [restore, setRestore] = useState<Restore>();
  // Restores made in this popup, shown at once until their recorded change arrives.
  const [pending, setPending] = useState<Change[]>([]);
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    let current = true;
    setState({});
    invoke<unknown>('history', { pageId })
      .then((response) => current && setState({ value: readHistory(response) }))
      .catch((error: unknown) => current && setState({ error: failure(error) }));
    return () => {
      current = false;
    };
  }, [pageId, round]);
  // Rereads quietly, keeping the table, and drops each pending row once its label's newest
  // recorded change is an addition.
  useEffect(() => {
    if (!pending.length || recheck >= rechecks) return;
    let current = true;
    const timer = setTimeout(() => {
      invoke<unknown>('history', { pageId })
        .then((response) => {
          if (!current) return;
          const value = readHistory(response);
          setState({ value });
          setPending((list) =>
            list.filter((p) => value.changes.find((c) => c.label === p.label)?.action !== 'added'),
          );
        })
        .catch(() => undefined)
        .finally(() => current && setRecheck((n) => n + 1));
    }, recheckMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [pageId, pending, recheck]);
  if (state.error) return <Failure message={state.error} retry={() => setRound((r) => r + 1)} />;
  if (!state.value) return <Spinner label="Loading label history" />;
  const { page, older, canEdit } = state.value;
  const changes = [...pending, ...state.value.changes];
  if (!changes.length) return <Text>No label changes recorded for this page yet.</Text>;
  const undoable = restorable(changes);
  const busy = restore?.step === 'sending';
  const confirm = () => {
    if (!restore || restore.step !== 'confirm') return;
    const { label } = restore;
    setRestore({ label, step: 'sending' });
    invoke<unknown>('restore', { pageId: page.id, label })
      .then((response) => {
        readRestore(response);
        setPending((list) => [
          { at: new Date().toISOString(), action: 'added', label, actor: accountId },
          ...list,
        ]);
        setRecheck(0);
        setRestore({ label, step: 'done' });
      })
      .catch((error: unknown) => setRestore({ label, step: 'failed', message: failure(error) }));
  };
  const restoreCell = (c: Change, i: number) =>
    undoable[i] ? (
      <Button isDisabled={busy} onClick={() => setRestore({ label: c.label, step: 'confirm' })}>
        Restore
      </Button>
    ) : null;
  return (
    <Stack space="space.200">
      {older ? <Text>The latest 100 changes. Older ones aren't kept.</Text> : null}
      {restore ? (
        <RestoreMessage
          restore={restore}
          title={page.title}
          confirm={confirm}
          close={() => setRestore(undefined)}
        />
      ) : null}
      <DynamicTable
        caption="Label changes"
        head={{
          cells: [
            { key: 'when', content: 'When' },
            { key: 'change', content: 'Change' },
            { key: 'label', content: 'Label' },
            { key: 'actor', content: 'Changed by' },
            ...(canEdit ? [{ key: 'restore', content: 'Restore' }] : []),
          ],
        }}
        rows={changes.map((c, i) => ({
          key: `${i}`,
          cells: [
            { key: 'when', content: when(c.at) },
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
  if (content.type !== 'page' || typeof content.id !== 'string')
    return <Text>Label History records page labels only.</Text>;
  return (
    <PageHistory
      pageId={content.id}
      accountId={typeof context.accountId === 'string' ? context.accountId : null}
    />
  );
}
ForgeReconciler.render(<App />);
