/**
 * Extract the venue-looking strings from a Zotero item.
 *
 * Depending on the user's habits and on the translator that created the entry,
 * the journal / conference name can live in a lot of different fields:
 *
 *  - journalArticle      -> publicationTitle, journalAbbreviation
 *  - conferencePaper     -> proceedingsTitle, conferenceName, publicationTitle
 *  - conferenceProceedings (the volume itself) -> same as above
 *  - preprint            -> repository, publicationTitle, institution
 *  - thesis / report     -> university, institution, publisher
 *
 * Some users also paste the whole "Proceedings of the 2024 ... (CVPR)" line
 * into one field, which the normalizer handles.
 */

export type VenueKindHint = "conference" | "journal" | "preprint" | "other";

export interface ItemFieldReader {
  getField?(
    field: string,
    unformatted?: boolean,
    includeBaseMapped?: boolean,
  ): string;
  itemType?: string;
  itemTypeID?: number;
}

export interface VenueCandidates {
  /** Raw strings, in decreasing order of trust. */
  values: string[];
  /** ISSN / ISBN found on the item. */
  issn: string;
  kindHint: VenueKindHint;
  /**
   * The venue the user typed into the item ("Publication", "Conference
   * Title", ...), ignoring values that only say "this is a preprint".
   * Empty when the item names no venue of its own.
   */
  namedVenue: string;
  /** Type-specific hints. */
  flags: {
    isPreprint: boolean;
    isConference: boolean;
    isJournal: boolean;
  };
}

const SHORT_JOURNAL_MARKERS =
  /\b(?:journal|transactions|trans\.?|letters|review|bulletin|magazine|annals|proceedings of the ieee)\b/i;

/** Venue fields the user can fill in, most trusted first. */
const NAMED_VENUE_FIELDS = [
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "journalAbbreviation",
] as const;

/** Values that only mark a preprint, they do not name a venue. */
const PREPRINT_MARKERS =
  /\b(?:arxiv|biorxiv|medrxiv|ssrn|corr|preprint|research\s+square)\b/i;

function readField(item: ItemFieldReader, field: string): string {
  try {
    const value = item?.getField?.(field);
    return typeof value === "string" ? value.trim() : "";
  } catch (_error) {
    return "";
  }
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The venue the user entered on the item itself.
 *
 * A preprint item can still carry a venue: a paper under review is often filed
 * as a preprint while its "Publication" field already names the journal. That
 * explicit entry is a stronger signal than the generic "this also exists on
 * arXiv" one, so the preprint markers are skipped here.
 */
export function namedVenueOf(item: ItemFieldReader): string {
  return firstNonEmpty(
    ...NAMED_VENUE_FIELDS.map((field) => readField(item, field)).filter(
      (value) => value && !PREPRINT_MARKERS.test(value),
    ),
  );
}

/**
 * Collect every field that may hold a venue name for the given item.
 */
export function collectVenueCandidates(item: ItemFieldReader): VenueCandidates {
  const type = String(item?.itemType ?? "").toLowerCase();
  const publicationTitle = readField(item, "publicationTitle");
  const journalAbbreviation = readField(item, "journalAbbreviation");
  const proceedingsTitle = readField(item, "proceedingsTitle");
  const conferenceName = readField(item, "conferenceName");
  const repository = readField(item, "repository");
  const institution = readField(item, "institution");
  const university = readField(item, "university");
  const publisher = readField(item, "publisher");
  const series = readField(item, "series");
  const issn = readField(item, "ISSN");

  const namedVenue = namedVenueOf(item);

  // The preprint verdict is a fallback: it only stands when the user did not
  // name a venue. This keeps an under-review paper that is filed as a preprint
  // (repository "arXiv") but tagged with its target journal out of the
  // "预印本" bucket.
  const isPreprint =
    !namedVenue &&
    (type === "preprint" ||
      PREPRINT_MARKERS.test(repository) ||
      PREPRINT_MARKERS.test(publicationTitle));

  const isConference =
    type === "conferencepaper" ||
    type === "conferenceproceedings" ||
    !!proceedingsTitle ||
    !!conferenceName;

  const isJournal = type === "journalarticle" || !!publicationTitle;

  const values: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!values.includes(trimmed)) values.push(trimmed);
  };

  if (type === "conferencepaper" || type === "conferenceproceedings") {
    push(conferenceName);
    push(proceedingsTitle);
    push(publicationTitle);
    push(series);
  } else if (type === "journalarticle") {
    push(publicationTitle);
    push(journalAbbreviation);
    push(conferenceName);
  } else if (isPreprint) {
    push(repository);
    push(publicationTitle);
    push(institution);
    push(publisher);
  } else {
    // thesis, report, book, bookSection, manuscript, ...
    push(proceedingsTitle);
    push(conferenceName);
    push(publicationTitle);
    push(university);
    push(institution);
    push(publisher);
    push(series);
  }

  return {
    values,
    issn,
    kindHint: isPreprint
      ? "preprint"
      : isConference
        ? "conference"
        : isJournal
          ? "journal"
          : "other",
    namedVenue,
    flags: { isPreprint, isConference, isJournal },
  };
}

/** Heuristic: does this string look like a journal rather than a conference? */
export function looksLikeJournal(value: string): boolean {
  return SHORT_JOURNAL_MARKERS.test(value);
}

/** Heuristic: is this item an arXiv / preprint style record? */
export function isPreprintItem(item: ItemFieldReader): boolean {
  return collectVenueCandidates(item).flags.isPreprint;
}

/** Item types that never describe a venue. */
const SKIPPED_ITEM_TYPES = new Set(
  [
    "note",
    "attachment",
    "annotation",
    "dataset",
    "artwork",
    "audioRecording",
    "videoRecording",
    "podcast",
    "interview",
    "presentation",
    "document",
    "letter",
    "email",
    "instantMessage",
    "forumPost",
    "tweet",
  ].map((type) => type.toLowerCase()),
);

/**
 * Whether the item is a regular paper-like record worth identifying.
 * `item.isRegularItem()` is still checked by the caller; this only filters by
 * item type.
 */
export function isRankableItemType(itemType: string | undefined): boolean {
  const normalized = String(itemType ?? "").toLowerCase();
  if (!normalized) return true;
  return !SKIPPED_ITEM_TYPES.has(normalized);
}
