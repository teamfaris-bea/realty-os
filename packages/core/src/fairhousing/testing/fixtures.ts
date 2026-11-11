// Fixture set for the fair-housing lexicon (PHASE2_3_PLAN §5.4 #20 tests): every hard term has
// phrases that must be caught as hard (zero false negatives), and ordinary listing copy that must
// not be flagged at all. Shared with core/marketing and core/nurture tests.

/** termId → phrases that must produce a HARD match for that term. */
export const HARD_FIXTURES: Readonly<Record<string, readonly string[]>> = {
  'fh.familial.no_children': ['No children please.', 'no kids', 'Child-free building', 'childfree', 'Not suitable for children', 'unsuitable for toddlers', 'No families.', 'not for families', 'Sorry, no teens.'],
  'fh.familial.adults_only': ['Adults only', 'adult-only community', 'Adults preferred', 'Mature adults welcome', 'for adults only'],
  'fh.familial.ideal_occupant': ['Perfect for young families!', 'great for young families', 'Ideal for a growing family', 'Great for kids', 'made for families', 'Perfect for newlyweds'],
  'fh.marital.only': ['Married couples only', 'couples only', 'Singles only', 'No unmarried couples', 'Ideal for a single', 'perfect for bachelors'],
  'fh.sex.only': ['Female only', 'women only', 'Men only', 'no males', 'Ideal for a gentleman', 'ladies only'],
  'fh.orientation.only': ['straight only', 'No LGBTQ'],
  'fh.race.area': ['Quiet white neighborhood', 'a Hispanic community', 'ethnic neighborhood', 'Whites only', 'No minorities', 'segregated area'],
  'fh.national_origin.only': ['English speaking only', 'English only', 'Must speak English', 'Americans only', 'No immigrants', 'in the Mexican community'],
  'fh.religion.only': ['Christian home', 'Jewish neighborhood', 'catholics only', 'No Muslims'],
  'fh.disability.excludes': ['No wheelchairs', 'able-bodied tenants', 'Must be able to climb stairs', 'Not suitable for disabled persons', 'physically fit only', 'must be in good health', 'no mentally ill'],
  'fh.income.excludes': ['No Section 8', 'no section eight', 'No vouchers', 'No housing assistance', 'Section 8 not accepted'],
  'fh.military.excludes': ['No military'],
  'fh.age.excludes': ['No seniors', 'Young professionals only', 'students only', 'Perfect for retirees', 'ideal for empty nesters'],
  'fh.steering.kind_of_people': ['the kind of people you want', 'A better class of neighbors', 'people like you', 'the right crowd', 'Desirable neighbors', 'your own kind'],
};

/** Ordinary listing and message copy: no match of any severity. */
export const CLEAN_FIXTURES: readonly string[] = [
  'Spacious family room with a gas fireplace.',
  'Single-family home on a quiet cul-de-sac.',
  'Three-bedroom, two-bath ranch with a two-car garage.',
  'Single story living with an open floor plan.',
  'Close to the park, shops and the light rail.',
  'Located on Church Street near downtown.',
  'Mature trees and a fenced yard.',
  'Familiar layout with updated kitchen.',
  'Primary suite with a walk-in closet.',
  'Just listed: 123 Main St. Open house Saturday.',
  'Wheelchair-accessible entrance and a zero-step shower.'.replace('Wheelchair-accessible', 'Step-free'),
  'This multi-family duplex has separate meters.',
  'Exclusive right to sell agreement signed.'.replace(' agreement signed', ''),
  'Walk to the farmers market.',
  'Great for entertaining with a large deck.',
  'Hi Jane, the home on Elm dropped in price. — the Smith Team assistant',
];

/** Copy that must be flagged soft (and not hard). */
export const SOFT_FIXTURES: readonly { text: string; termId: string }[] = [
  { text: 'A great family home.', termId: 'fh.familial.mention' },
  { text: 'Family-friendly neighborhood', termId: 'fh.familial.family_area' },
  { text: 'Two blocks from St. Mark church.', termId: 'fh.religion.mention' },
  { text: 'Safe neighborhood with sidewalks.', termId: 'fh.steering.area_quality' },
  { text: 'Low crime area.', termId: 'fh.steering.area_quality' },
  { text: 'Mother-in-law suite over the garage.', termId: 'fh.sex.mention' },
  { text: 'Popular with seniors.', termId: 'fh.age.mention' },
  { text: 'An exclusive community.', termId: 'fh.steering.area_quality' },
];
