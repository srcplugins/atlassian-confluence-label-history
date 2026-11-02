// Readers for resolver responses: the UI renders only values of the expected shape.
import { isRecord, isText, unwrapResponse } from './shared/response.mjs';

export interface SpaceAccess {
  spaceId: string;
  spaceKey: string;
  name: string;
}

const isFilled = (value: unknown, max: number): value is string =>
  isText(value, max) && value.trim() !== '';

/** The space the `load` resolver read. A malformed envelope or value throws. */
export function readSpace(response: unknown): SpaceAccess {
  const value = unwrapResponse(response);
  if (
    !isRecord(value) ||
    !isFilled(value.spaceId, 32) ||
    !isFilled(value.spaceKey, 255) ||
    !isFilled(value.name, 255)
  )
    throw Error('Invalid response');
  return { spaceId: value.spaceId, spaceKey: value.spaceKey, name: value.name };
}
