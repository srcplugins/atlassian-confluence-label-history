import React, { useRef, useState } from 'react';
import ForgeReconciler, { Heading, LoadingButton, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { readSpace } from './client';
import { PublicResponseError } from './shared/response.mjs';

function App() {
  const [message, setMessage] = useState('Ready.');
  const [busy, setBusy] = useState(false);
  // A loading button still accepts clicks, so only the latest request may set the result.
  const latest = useRef(0);
  async function load() {
    const request = ++latest.current;
    setBusy(true);
    let next: string;
    try {
      next = `You can read ${readSpace(await invoke<unknown>('load')).spaceKey}.`;
    } catch (error) {
      next =
        error instanceof PublicResponseError
          ? error.message
          : 'Could not check space access. Try again.';
    }
    if (request !== latest.current) return;
    setMessage(next);
    setBusy(false);
  }
  return (
    <Stack space="space.200">
      <Heading as="h2">Label History for Confluence</Heading>
      <Text>{message}</Text>
      {/* Loading, not disabled, while it runs, so the pressed button keeps keyboard focus. */}
      <LoadingButton onClick={() => void load()} isLoading={busy}>
        Check space access
      </LoadingButton>
    </Stack>
  );
}
ForgeReconciler.render(<App />);
