/**
 * @fileoverview Session storage helpers — this labeled comment is the
 * file-level doc even though it is adjacent to the import below.
 */
import { MAX_RETRIES } from "./login";

/**
 * Persist sessions with automatic retry.
 */
@Registered()
export class SessionStore {
  limit = MAX_RETRIES;
}

function Registered(): ClassDecorator {
  return () => {};
}
