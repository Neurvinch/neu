import { createVaultStore } from '@seal/shared/vault';
import { canonicalize, sha256Hex, utf8 } from '@seal/shared';

/**
 * The console's own key store.
 *
 * Console-resident keys exist for staff who do not sign payments -- and, in the
 * demo, to show what the policy refuses. An executive cannot use one: the
 * server rejects a signature from a console credential outright, because a key
 * living in the same browser that composes payments would let one compromised
 * machine both write a payment and authorize it.
 *
 * Executives enrol on the SEAL Authenticator instead.
 */
export const vault = createVaultStore({
  namespace: 'seal.console.vault',
  deviceKind: 'console',
});

export const hashOf = (value: unknown) => sha256Hex(utf8(canonicalize(value)));

export type { Vault } from '@seal/shared/vault';
export { WrongPassphrase } from '@seal/shared/vault';
