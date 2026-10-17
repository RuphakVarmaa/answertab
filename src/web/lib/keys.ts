// Keyboard rules shared by the console. Pure over a minimal element shape, so node tests can cover them.

export interface KeyTarget {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** Controls that Space activates or types into. Push-to-talk must never steal Space from these. */
const CONTROL = 'a[href],button,input,textarea,select,summary,dialog,[contenteditable=""],[contenteditable="true"],[role="button"],[role="tab"],[role="radio"],[role="checkbox"],[role="switch"],[role="option"],[role="menuitem"]'

/**
 * Hold Space to talk only when focus is on the push-to-talk button itself, or nowhere in particular
 * (the page body or plain console text). Any other control keeps Space.
 */
export function spaceStartsTalk(target: KeyTarget | null | undefined, ptt: unknown, body: unknown): boolean {
  if (!target) return true
  if (target === ptt) return true
  if (target === body) return true
  if (target.isContentEditable) return false
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'HTML' || tag === 'BODY') return true
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(tag)) return false
  return !target.closest?.(CONTROL)
}
