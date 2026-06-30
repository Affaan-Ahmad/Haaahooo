/**
 * Tiny localStorage cache so the PWA can show the chat list and recent
 * messages while offline. Text survives offline; images may not (their signed
 * URLs are remote and can expire). New messages still require a connection.
 */

const PREFIX = "haaahooo:cache:";
const MAX_MESSAGES = 250;

function safeSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / private mode / SSR — ignore
  }
}

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveChatsCache(chats: unknown[]) {
  safeSet(`${PREFIX}chats`, chats);
}

export function readChatsCache<T>(): T[] {
  return safeGet<T[]>(`${PREFIX}chats`) ?? [];
}

export function saveMessagesCache(conversationId: string, messages: unknown[]) {
  // Keep only the most recent messages to stay within storage limits.
  const trimmed = messages.slice(-MAX_MESSAGES);
  safeSet(`${PREFIX}messages:${conversationId}`, trimmed);
}

export function readMessagesCache<T>(conversationId: string): T[] {
  return safeGet<T[]>(`${PREFIX}messages:${conversationId}`) ?? [];
}
