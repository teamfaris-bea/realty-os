// NANP area code → the state or territory it serves (docs/AI_ISA.md §5.3; R-ISA-10). Versioned static data.
// EVERY ROW VERIFY (codes are added and overlaid over time). An area code's zones are every zone of its state
// (./stateZones.ts), so a multi-zone state's code lists each zone: conservative by design, since the zone set is a
// union that only ever narrows the send window. Seeded into `ai_isa_area_code_zones` by ISA-2; a test keeps the
// two equal. A number with an unknown code adds nothing (the continental set and the tenant zone still apply).
import { zonesOfState } from './stateZones.js';

export const AREA_CODES_VERSION = 'isa-area-codes/2026.11.0';

const BY_STATE: Readonly<Record<string, string>> = {
  AL: '205 251 256 334 659 938',
  AK: '907',
  AZ: '480 520 602 623 928',
  AR: '327 479 501 870',
  CA: '209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951',
  CO: '303 719 720 970 983',
  CT: '203 475 860 959',
  DE: '302',
  DC: '202 771',
  FL: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  GA: '229 404 470 478 678 706 762 770 912 943',
  HI: '808',
  ID: '208 986',
  IL: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
  IN: '219 260 317 463 574 765 812 930',
  IA: '319 515 563 641 712',
  KS: '316 620 785 913',
  KY: '270 364 502 606 859',
  LA: '225 318 337 504 985',
  ME: '207',
  MD: '227 240 301 410 443 667',
  MA: '339 351 413 508 617 774 781 857 978',
  MI: '231 248 269 313 517 586 616 679 734 810 906 947 989',
  MN: '218 320 507 612 651 763 924 952',
  MS: '228 601 662 769',
  MO: '235 314 417 557 573 636 660 816 975',
  MT: '406',
  NE: '308 402 531',
  NV: '702 725 775',
  NH: '603',
  NJ: '201 551 609 640 732 848 856 862 908 973',
  NM: '505 575',
  NY: '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934',
  NC: '252 336 472 704 743 828 910 919 980 984',
  ND: '701',
  OH: '216 220 234 283 326 330 380 419 436 440 513 567 614 740 937',
  OK: '405 539 572 580 918',
  OR: '458 503 541 971',
  PA: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  RI: '401',
  SC: '803 821 839 843 854 864',
  SD: '605',
  TN: '423 615 629 731 865 901 931',
  TX: '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979',
  UT: '385 435 801',
  VT: '802',
  VA: '276 434 540 571 686 703 757 804 826 948',
  WA: '206 253 360 425 509 564',
  WV: '304 681',
  WI: '262 274 353 414 534 608 715 920',
  WY: '307',
  PR: '787 939',
  VI: '340',
  GU: '671',
  AS: '684',
  MP: '670',
  AB: '368 403 587 780 825',
  BC: '236 250 257 604 672 778',
  MB: '204 431 584',
  NB: '428 506',
  NL: '709 879',
  NS: '782 902',
  ON: '226 249 289 343 365 382 387 416 437 519 548 613 647 683 705 742 753 807 905 942',
  QC: '263 354 367 418 438 450 468 514 579 581 819 873',
  SK: '306 474 639',
  NT: '867',
};

/** area code → state or territory. Built once from BY_STATE; a code listed twice keeps every state. */
export const AREA_CODE_STATES: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [st, codes] of Object.entries(BY_STATE)) {
    for (const code of codes.split(' ')) (out[code] ??= []).push(st);
  }
  // 867 serves all three territories
  out['867'] = ['YT', 'NT', 'NU'];
  // 902 and 782 serve Nova Scotia and Prince Edward Island
  out['902'] = ['NS', 'PE'];
  out['782'] = ['NS', 'PE'];
  return Object.freeze(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.freeze([...new Set(v)])])));
})();

/** The NANP area code of a number in any common format ("+1 (843) 555-0100", "8435550100"), or null. */
export function areaCodeOf(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const d = phone.replace(/\D/g, '');
  const national = d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null;
  if (national === null || !/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return national.slice(0, 3);
}

/** Every zone an area code may be in (all zones of every state it serves), or []. */
export function areaCodeZones(code: string | null | undefined): string[] {
  if (typeof code !== 'string') return [];
  const states = AREA_CODE_STATES[code] ?? [];
  return [...new Set(states.flatMap((s) => [...zonesOfState(s)]))];
}
