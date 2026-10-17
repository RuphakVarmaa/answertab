// Published sandbox test cards. Sandbox only: bots and synthetic runs send these server-side so one
// Orders call returns COMPLETED + an authorization. Real fans use card fields in the browser.
// Each card here was authorized and voided against the sandbox by scripts/sandbox-proof/run.ts.

export interface TestCard {
  label: string
  brand: 'VISA' | 'MASTERCARD' | 'AMEX' | 'DISCOVER'
  number: string
  /** YYYY-MM, as Orders v2 expects. */
  expiry: string
  securityCode: string
  /** Cardholder name. DECLINE_NAME triggers a processor decline in sandbox. */
  name: string
  billingAddress: {
    addressLine1: string
    adminArea2: string
    adminArea1: string
    postalCode: string
    countryCode: string
  }
}

/** Cardholder name that makes the sandbox processor refuse the card (authorization DENIED, code 0500). */
export const DECLINE_NAME = 'CCREJECT-REFUSED'

const BILLING = {
  addressLine1: '2211 N First Street',
  adminArea2: 'San Jose',
  adminArea1: 'CA',
  postalCode: '95131',
  countryCode: 'US',
} as const

export const TEST_CARDS: readonly TestCard[] = [
  { label: 'Visa', brand: 'VISA', number: '4111111111111111', expiry: '2030-12', securityCode: '123', name: 'Bot Visa', billingAddress: BILLING },
  { label: 'Mastercard', brand: 'MASTERCARD', number: '5555555555554444', expiry: '2030-12', securityCode: '123', name: 'Bot Mastercard', billingAddress: BILLING },
  { label: 'Amex', brand: 'AMEX', number: '371449635398431', expiry: '2030-12', securityCode: '1234', name: 'Bot Amex', billingAddress: BILLING },
  { label: 'Discover', brand: 'DISCOVER', number: '6011111111111117', expiry: '2030-12', securityCode: '123', name: 'Bot Discover', billingAddress: BILLING },
]

/** Round-robin card for bot number `i`. */
export function botCard(i: number, displayName?: string): TestCard {
  const card = TEST_CARDS[((i % TEST_CARDS.length) + TEST_CARDS.length) % TEST_CARDS.length]!
  return displayName ? { ...card, name: displayName } : card
}

/** Same card, cardholder name set to the sandbox decline trigger. */
export function declineCard(base: TestCard = TEST_CARDS[0]!): TestCard {
  return { ...base, label: `${base.label} (declines)`, name: DECLINE_NAME }
}

/** What the judge types into card fields (shown by GET /api/config). Expiry is MM/YY as typed in the browser. */
export const JUDGE_TEST_CARD = { number: '4111111111111111', expiry: '12/30', cvv: '123', name: 'Judge Test' } as const
