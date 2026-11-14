// b17 round 2: Ofcom's TV and radio drama numbers, which are never assigned to a line, for the phone guards beside
// this file (fictionalPhones.test.ts for +44 numbers, fictionalUsPhones.test.ts for a UK number written as digits).
// Every one of Ofcom's published drama ranges counts as fictional (docs/CONVENTIONS.md lists them, and
// fictionalPhones.test.ts checks that list matches this one).

/**
 * Ofcom's drama blocks, as the first seven digits after +44; each holds the 1,000 numbers that end 000 to 999.
 * b17: also 028 9649 6xxx, 03069 990xxx, 0808 157 0xxx and 0909 879 0xxx (Ofcom's other drama blocks), which
 * packages/core/src/testing/phones.ts makes bulk test numbers from; b17 round 2: also 029 2018 0xxx (Cardiff).
 */
export const DRAMA_BLOCKS: readonly string[] = [
  '2079460', // 020 7946 0xxx (London)
  '7700900', // 07700 900xxx (mobile)
  '1632960', // 01632 960xxx (no area)
  // 0113, 0114, 0115, 0116, 0117, 0118, 0121, 0131, 0141, 0151 and 0161 496 0xxx (the big cities)
  '1134960', '1144960', '1154960', '1164960', '1174960', '1184960', '1214960', '1314960', '1414960', '1514960', '1614960',
  '1914980', // 0191 498 0xxx (Tyneside, Durham and Sunderland)
  '2896496', // 028 9649 6xxx (Northern Ireland)
  '2920180', // 029 2018 0xxx (Cardiff)
  '3069990', // 03069 990xxx (UK-wide)
  '8081570', // 0808 157 0xxx (freephone)
  '9098790', // 0909 879 0xxx (premium rate)
];

/** True for ten digits after +44 in one of Ofcom's drama blocks. */
export const isDramaNumber = (digitsAfter44: string): boolean => /^\d{10}$/.test(digitsAfter44) && DRAMA_BLOCKS.includes(digitsAfter44.slice(0, 7));
