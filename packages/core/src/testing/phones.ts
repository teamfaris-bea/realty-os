// b17 (B17R-2): fictional phone numbers for tests, fixtures, seeds and fakes. Not for production paths.
//
// The repository is public, so every phone number a test writes or makes up is one kept for fiction:
// - NANP: +1 NXX 555-0100 to 555-0199, in any area code. One area code holds only 100, so the area code is the second
//   dimension: code that needs more numbers steps through area codes, 100 numbers each.
// - UK: Ofcom's drama ranges (020 7946 0xxx, 0113 496 0xxx and the other big-city 496 blocks, 0191 498 0xxx,
//   028 9649 6xxx, 0808 157 0xxx, 0909 879 0xxx, 03069 990xxx).
// Within an area code, 555-0150 to 555-0176 belong to the fake telephony provider (it sells numbers there); numbers
// tests write out sit from 555-0100 to 555-0149 and from 555-0177 to 555-0199.
//
// bulkFictionalPhone(i) gives up to BULK_FICTIONAL_PHONES (58,900) distinct numbers that libphonenumber's full
// metadata accepts as valid, for tests that need more than a few area codes hold (imports of 50,000 rows): every
// geographic NANP area code where all of 555-0100 to 555-0199 are valid (US codes first, then Canada and the
// Caribbean), then the UK drama ranges, and last the US codes tests already use (RESERVED_AREAS), so the first
// BULK_UNSHARED numbers never share an area code with a number a test writes, randomPhone makes or the fake sells.

/** US area codes where libphonenumber accepts every line from 555-0100 to 555-0199 as valid. */
export const US_FICTIONAL_AREAS: readonly string[] = `
  201 202 203 205 206 207 208 209 210 212 213 214 215 216 217 218 219 220 223 224 225 227 228 229 231 234 235
  239 240 248 251 252 253 254 256 260 262 267 269 270 272 274 276 279 281 283 301 302 303 304 305 307 308 309
  310 312 313 314 315 316 317 318 319 320 321 323 324 325 326 327 329 330 331 332 334 336 337 339 341 346 347
  350 351 352 353 360 361 363 364 369 380 385 386 401 402 404 405 406 407 408 409 410 412 413 414 415 417 419
  423 424 425 430 432 434 435 440 442 443 445 447 448 458 463 464 469 470 472 475 478 479 480 484 500 501 502
  503 504 505 507 508 509 510 512 513 515 516 517 518 520 521 522 525 526 527 528 529 530 531 532 533 534 539
  540 541 544 551 557 559 561 562 563 564 566 567 570 571 572 573 574 575 577 580 582 585 586 588 601 602 603
  605 606 607 608 609 610 612 614 615 616 617 618 619 620 623 626 628 629 630 631 636 640 641 645 646 650 651
  656 657 659 660 661 662 667 669 678 680 681 682 686 689 701 702 703 704 706 707 708 712 713 714 715 716 717
  718 719 720 724 725 726 727 728 730 731 732 734 737 738 740 743 747 748 754 757 760 762 763 765 769 770 771
  772 773 774 775 779 781 785 786 800 801 802 803 804 805 806 808 810 812 813 814 815 816 817 818 820 821 826
  828 830 831 832 833 835 838 839 840 843 844 845 847 848 850 854 855 856 857 858 859 860 862 863 864 865 866
  870 872 877 878 888 900 901 903 904 906 907 908 909 910 912 913 914 915 916 917 918 919 920 925 928 929 930
  931 934 936 937 938 940 941 943 945 947 948 949 951 952 954 956 959 970 971 972 973 975 978 979 980 983 984
  985 986 989
`.trim().split(/\s+/);

/** The same for the rest of the NANP (Canada and the Caribbean). */
export const OTHER_NANP_FICTIONAL_AREAS: readonly string[] = `
  204 226 236 249 250 257 263 273 289 306 340 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474
  506 514 519 548 579 581 584 587 600 604 613 622 633 639 647 658 670 671 672 683 705 709 742 753 778 780 782
  784 787 807 809 819 825 829 849 867 873 876 879 902 905 939 942
`.trim().split(/\s+/);

/**
 * US area codes already taken: the 27 California codes apps/api's randomPhone makes numbers in, the codes tests
 * write numbers in (415, 843, 212, 206 and so on), the demo seed's Boston codes, the DB tests' 201 to 205 and the fake
 * telephony provider's overflow codes (apps/api/src/providers/fake/telephony.ts FAKE_OVERFLOW_AREAS).
 */
export const RESERVED_AREAS: readonly string[] = `
  209 213 323 408 424 530 559 562 619 626 650 657 661 669 707 714 747 760 805 818 831 858 909 916 925 949 951
  201 202 203 205 206 212 310 312 415 503 510 512 617 646 781 800 808 843 855 857 907 210 214 215 216 217
`.trim().split(/\s+/);

/** Ofcom drama blocks libphonenumber accepts as valid, as digits after +44; each holds 1,000 numbers (000-999). */
export const UK_DRAMA_BLOCKS: readonly string[] = ['2079460', '1134960', '1144960', '1164960', '1174960', '1184960', '1214960', '1314960', '1414960', '1514960', '1614960', '1914980', '2896496', '3069990', '8081570', '9098790'];

/** Non-geographic US codes (personal communications services, toll-free, premium): left out of bulk numbers. */
export const NON_GEOGRAPHIC_AREAS: readonly string[] = ['500', '521', '522', '525', '526', '527', '528', '529', '532', '533', '544', '566', '577', '588', '800', '833', '844', '855', '866', '877', '888', '900'];

const reserved = new Set(RESERVED_AREAS);
const geographic = US_FICTIONAL_AREAS.filter((a) => !NON_GEOGRAPHIC_AREAS.includes(a));
const BULK_NANP_FIRST = [...geographic.filter((a) => !reserved.has(a)).reverse(), ...OTHER_NANP_FICTIONAL_AREAS];
const BULK_NANP_LAST = geographic.filter((a) => reserved.has(a));

/** How many bulk numbers never share an area code with a number tests write, randomPhone makes or the fake sells. */
export const BULK_UNSHARED = BULK_NANP_FIRST.length * 100 + UK_DRAMA_BLOCKS.length * 1000;
/** How many distinct numbers bulkFictionalPhone gives. */
export const BULK_FICTIONAL_PHONES = BULK_UNSHARED + BULK_NANP_LAST.length * 100;

/** A fictional NANP number in E.164: +1 <area> 555-01<nn> (nn from 0 to 99). */
export function fictionalNanp(area: string, nn: number): string {
  if (!/^[2-9]\d{2}$/.test(area) || !Number.isInteger(nn) || nn < 0 || nn > 99) throw new Error(`fictionalNanp: ${area} ${nn}`);
  return `+1${area}55501${String(nn).padStart(2, '0')}`;
}

/** The i-th of BULK_FICTIONAL_PHONES distinct, valid, fictional numbers (i from 0), in E.164. */
export function bulkFictionalPhone(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= BULK_FICTIONAL_PHONES) throw new Error(`bulkFictionalPhone: ${i} is outside 0 to ${BULK_FICTIONAL_PHONES - 1}`);
  const nanpFirst = BULK_NANP_FIRST.length * 100;
  if (i < nanpFirst) return fictionalNanp(BULK_NANP_FIRST[Math.floor(i / 100)]!, i % 100);
  const uk = i - nanpFirst;
  if (uk < UK_DRAMA_BLOCKS.length * 1000) return `+44${UK_DRAMA_BLOCKS[Math.floor(uk / 1000)]}${String(uk % 1000).padStart(3, '0')}`;
  const last = uk - UK_DRAMA_BLOCKS.length * 1000;
  return fictionalNanp(BULK_NANP_LAST[Math.floor(last / 100)]!, last % 100);
}

/** A NANP number as people write it, (617) 555-0101; any other number stays E.164. */
export function written(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
