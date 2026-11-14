// b17 (B17R-2): the repository is public, so a phone number a DB test makes up is fictional, +1 NXX 555-0100 to
// 555-0199, as every number written in the repository is (apps/web/src/test/fictionalUsPhones.test.ts keeps them so).
// One area code holds 100 of them, so the area code is the second dimension: the n-th made-up number of a test file
// takes area code 201 + n / 100 and line 555-0100 + n % 100 (201 to 205, 500 numbers). The numbers the DB tests write
// out use other area codes (555, 415, 843 and so on), so a made-up number never equals one of them.

/** The n-th made-up number (n from 0 to 499). */
export function fictionalPhone(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 500) throw new Error(`fictionalPhone: ${n} is outside 0 to 499`);
  return `+1${201 + Math.floor(n / 100)}55501${String(n % 100).padStart(2, '0')}`;
}

let seq = 0;
/** The next made-up number of this test file (one counter for every fixture the file loads). */
export const nextFictionalPhone = (): string => fictionalPhone(seq++);

/**
 * The same as SQL, for fixtures that build rows in SQL: the first fictional number from 201 to 205 that no
 * phone_numbers row holds yet (phone_numbers.e164 is unique among live numbers).
 */
export const FREE_FICTIONAL_E164_SQL = `(SELECT '+1' || a || '55501' || lpad(l::text, 2, '0') FROM generate_series(201, 205) a, generate_series(0, 99) l
  WHERE NOT EXISTS (SELECT 1 FROM public.phone_numbers n WHERE n.e164 = '+1' || a || '55501' || lpad(l::text, 2, '0')) ORDER BY a, l LIMIT 1)`;
