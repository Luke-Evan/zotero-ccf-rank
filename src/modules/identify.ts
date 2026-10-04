/**
 * Identification pipeline: from a Zotero item to a `RankRecord`.
 *
 * Two independent sources are combined:
 *  - DBLP (+ the bundled CCF catalog)   -> CCF rank, venue abbreviation
 *  - LetPub (cached CAS journal table)  -> 中科院分区
 *
 * Both are optional and a failure of one never prevents the other from being
 * written. Matching never depends on the network alone: the venue strings of
 * the item itself are always tried against the catalog.
 */

import {
  LEGACY_NOTE_TITLE,
  RankRecord,
  isoDate,
  parseLegacyNoteContent,
  parseRankRecord,
  recordFromLegacyCcfInfo,
} from "./record";
import { collectVenueCandidates, isRankableItemType } from "./venue/itemFields";
import {
  TopJournal,
  encodeTopJournal,
  topJournalByIssn,
  topJournalByName,
} from "../data/topJournals";
import {
  VenueAlias,
  VenueMatch,
  getUserAliases,
  matchVenueByIssn,
  resolveVenueFromCandidates,
} from "./venue/resolver";
import type { DblpClient } from "./net/dblp";
import { isPreprintPath, pickHit } from "./net/dblp";
import type { CasClient } from "./cas/letpub";
import type { CasJournalEntry, CasStore } from "./cas/store";
import { ccfRankList } from "../data/ccfCatalog";

export interface MinimalItem {
  id?: number;
  libraryID?: number;
  itemType?: string;
  getField?(
    field: string,
    unformatted?: boolean,
    includeBaseMapped?: boolean,
  ): string;
  getNotes?(): number[];
  isRegularItem?(): boolean;
  isNote?(): boolean;
  isAttachment?(): boolean;
}

export interface IdentifyOptions {
  dblpEnabled: boolean;
  casEnabled: boolean;
  casCacheTtlDays: number;
  aliasMapping: string;
}

export interface IdentifyDeps {
  dblp?: DblpClient;
  cas?: CasClient;
  casStore?: CasStore;
  options: IdentifyOptions;
  /** Called when a background CAS refresh produced a new value. */
  onCasUpdated?: (entry: CasJournalEntry, staleRecord: RankRecord) => void;
  log?: (message: string, ...args: unknown[]) => void;
}

export interface IdentifyResult {
  record: RankRecord;
  changed: boolean;
  /** True when a background CAS refresh was scheduled for this item. */
  casRefreshScheduled: boolean;
  /** Machine readable trace, handy for debugging a wrong result. */
  notes: string[];
}

function readField(item: MinimalItem, field: string): string {
  try {
    return String(item.getField?.(field) ?? "").trim();
  } catch (_error) {
    return "";
  }
}

/** Read the record from the Extra field, falling back to the legacy note. */
export function readRecord(item: MinimalItem): RankRecord {
  const record = parseRankRecord(readField(item, "extra"));
  if (record.ccf || record.cas || record.citation) return record;

  // Legacy support: the previous plugin stored a JSON blob in a child note.
  try {
    const noteIDs = item.getNotes?.() ?? [];
    for (const noteID of noteIDs) {
      const note = (globalThis as any).Zotero?.Items?.get?.(noteID);
      if (!note?.getNoteTitle || note.getNoteTitle() !== LEGACY_NOTE_TITLE) {
        continue;
      }
      const parsed = parseLegacyNoteContent(note.getNote?.() ?? "");
      if (!parsed) continue;
      return recordFromLegacyCcfInfo(parsed.ccfInfo, parsed.citationNumber);
    }
  } catch (_error) {
    // The note is only a fallback; ignore read errors.
  }
  return record;
}

function getYear(item: MinimalItem): string {
  const match = readField(item, "date").match(/(19|20)\d{2}/);
  return match ? match[0] : "";
}

/** Should this item be identified at all? */
export function isRankable(item: MinimalItem): boolean {
  try {
    if (item.isNote?.() || item.isAttachment?.()) return false;
    if (item.isRegularItem && !item.isRegularItem()) return false;
  } catch (_error) {
    return false;
  }
  return isRankableItemType(item.itemType);
}

/** Run one identification pass. */
export async function identifyItem(
  item: MinimalItem,
  deps: IdentifyDeps,
): Promise<IdentifyResult> {
  const log = deps.log ?? (() => undefined);
  const notes: string[] = [];
  const aliases: VenueAlias[] = getUserAliases(deps.options.aliasMapping);
  const previous = readRecord(item);
  const title = readField(item, "title");
  const candidates = collectVenueCandidates(item);
  const update: Partial<RankRecord> = {};
  let casRefreshScheduled = false;
  let source = "metadata";

  // ---- 1. metadata-only matching (offline, always available) ------------
  let match: VenueMatch | undefined = matchVenueByIssn(
    candidates.issn,
    aliases,
  );
  if (!match) {
    match = resolveVenueFromCandidates(
      candidates.values,
      aliases,
      candidates.kindHint,
    );
    if (match) notes.push(`metadata:${match.strategy}`);
  }
  let isPreprint = candidates.flags.isPreprint;
  let preprintFromDblp = false;

  // ---- 2. DBLP lookup for the CCF rank ---------------------------------
  if (deps.options.dblpEnabled && deps.dblp && title) {
    try {
      const result = await deps.dblp.lookup(title);
      if (result.status === "ok") {
        const hit = pickHit(result.hits, title);
        if (!hit) {
          notes.push("dblp:title-mismatch");
        } else {
          const ccfEntry = ccfRankList[hit.venuePath];
          if (ccfEntry) {
            match = {
              kind: "ccf",
              ccf: ccfEntry.rank,
              abbr: ccfEntry.abbr,
              full: ccfEntry.full,
              path: hit.venuePath,
              confidence: 1,
              strategy: "dblp",
            };
            source = "dblp";
            notes.push(`dblp:${hit.venuePath}`);
          } else if (isPreprintPath(hit.venuePath)) {
            // DBLP indexes the arXiv version of many papers whose venue record
            // is not there yet (a paper still under review, for instance), so a
            // CoRR hit only decides the kind when the item names no venue of
            // its own.
            if (candidates.namedVenue) {
              notes.push("dblp:preprint-ignored");
            } else {
              isPreprint = true;
              preprintFromDblp = true;
              source = "dblp";
              notes.push("dblp:preprint");
            }
          } else {
            const fromPath = resolveVenueFromCandidates(
              [hit.venuePath, hit.path],
              aliases,
              candidates.kindHint,
            );
            if (fromPath && (!match || fromPath.kind === "ccf")) {
              match = fromPath;
              source = "dblp";
              notes.push(`dblp-unranked:${hit.venuePath}`);
            } else {
              notes.push(`dblp-unranked:${hit.venuePath}`);
            }
          }
        }
      } else {
        notes.push(`dblp:${result.status}`);
      }
    } catch (error) {
      log("DBLP lookup failed", error);
      notes.push("dblp:error");
    }
  }

  // ---- 3. write the CCF part -------------------------------------------
  const year = getYear(item);
  void year;

  // CNS membership is independent of the CCF rank: CCF simply does not rank these
  // journals, so a Nature paper used to be labelled "无分区".
  const topJournal =
    topJournalByIssn(candidates.issn) ??
    candidates.values.reduce<TopJournal | undefined>(
      (found, name) => found ?? topJournalByName(name),
      undefined,
    ) ??
    topJournalByName(readField(item, "publicationTitle"));
  if (topJournal) {
    update.topJournal = encodeTopJournal(topJournal);
    notes.push(`top:${topJournal.abbr}`);
  }

  if (isPreprint) {
    update.ccf = "None";
    update.ccfVenue = "arXiv";
    update.venueType = "preprint";
    if (preprintFromDblp) update.source = "dblp";
  } else if (match) {
    update.ccf = match.ccf ?? "None";
    update.ccfVenue = match.abbr || match.full || "";
    update.venueType = guessVenueType(match, candidates.kindHint);
    update.source = source;
  } else if (candidates.kindHint === "other") {
    // Books, theses, reports, presentations: a CCF rank does not apply.
    update.ccf = "NotApplicable";
    update.venueType = "other";
    update.source = "metadata";
  } else {
    // Nothing matched this time. Keep a rank that an earlier pass did find:
    // DBLP may simply be unreachable, and overwriting a correct verdict with
    // "None" would turn a ranked paper into "无分区".
    const keepPrevious = Boolean(previous.ccfVenue);
    if (!keepPrevious) {
      update.ccf = "None";
    }
    update.venueType =
      candidates.kindHint === "journal"
        ? "journal"
        : candidates.kindHint === "conference"
          ? "conference"
          : "other";
    if (keepPrevious) {
      notes.push("metadata:kept-previous");
    } else {
      update.source = "metadata";
    }
  }
  update.updated = isoDate();
  if (match?.cas) update.cas = match.cas;

  // ---- 4. CAS (中科院分区) ---------------------------------------------
  // Conferences and preprints never have a 中科院分区, so they are skipped
  // structurally: only journal-like items are looked up.
  const venueType = update.venueType ?? previous.venueType ?? "";
  const isJournalLike =
    venueType === "journal" ||
    (candidates.flags.isJournal && !candidates.flags.isConference);
  const skipCas = isPreprint || !isJournalLike;

  if (deps.options.casEnabled && deps.cas && deps.casStore && !skipCas) {
    const journalName = resolveJournalName(
      candidates.values,
      match,
      previous,
      item,
    );
    const issn = candidates.issn || "";
    const cached = deps.casStore.lookup(journalName, issn, {
      ttlDays: deps.options.casCacheTtlDays,
    });
    if (cached) {
      if (cached.entry.zone && cached.entry.zone !== update.cas) {
        update.cas = cached.entry.zone;
        update.casVenue = cached.entry.name;
      }
      if (!cached.fresh) {
        casRefreshScheduled = true;
        scheduleCasRefresh(deps, {
          name: journalName || cached.entry.name,
          issn: issn || cached.entry.issn,
          affected: previous,
        });
      }
    } else if (journalName) {
      casRefreshScheduled = true;
      notes.push("cas:scheduled");
      scheduleCasRefresh(deps, { name: journalName, issn, affected: previous });
    } else {
      notes.push("cas:no-journal-name");
    }
  }

  const record: RankRecord = { ...previous };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || value === null || value === "") continue;
    (record as Record<string, string>)[key] = String(value);
  }

  return {
    record,
    changed: hasChanged(previous, record),
    casRefreshScheduled,
    notes,
  };
}

function guessVenueType(
  match: VenueMatch,
  hint: "conference" | "journal" | "preprint" | "other",
): string {
  if (match.path?.startsWith("/journals")) return "journal";
  if (match.path?.startsWith("/conf")) return "conference";
  if (hint === "preprint") return "preprint";
  return hint === "other" ? "other" : hint;
}

/**
 * The journal name to look up in the CAS table.
 *
 * Preference order:
 *  1. the full name of a matched journal (the catalog form),
 *  2. the journal-ish string taken from the item itself,
 *  3. the journal fields of the item, even when the venue matched as a
 *     conference (a journal article can be filed under a conference-like name),
 *  4. whatever was stored before.
 */
function resolveJournalName(
  candidates: string[],
  match: VenueMatch | undefined,
  previous: RankRecord,
  item?: MinimalItem,
): string {
  const first = candidates.find((value) => value && value.trim()) ?? "";
  if (match?.path?.startsWith("/journals")) {
    return match.full || match.abbr || first || "";
  }
  const fromItem = item ? journalFieldOf(item) : "";
  return first || fromItem || previous.casVenue || "";
}

/** The first journal-looking field value of the item. */
function journalFieldOf(item: MinimalItem): string {
  for (const field of ["publicationTitle", "journalAbbreviation"]) {
    const value = readField(item, field);
    if (value) return value;
  }
  return "";
}

function hasChanged(before: RankRecord, after: RankRecord): boolean {
  const keys: Array<keyof RankRecord> = [
    "ccf",
    "ccfVenue",
    "cas",
    "casVenue",
    "venueType",
    "source",
  ];
  return keys.some((key) => (before[key] ?? "") !== (after[key] ?? ""));
}

// ---------------------------------------------------------------------------
// Background CAS lookups
// ---------------------------------------------------------------------------

interface PendingCasRefresh {
  name: string;
  issn?: string;
  affected: RankRecord;
}

const casRefreshQueue = new Map<string, PendingCasRefresh>();
let casRefreshRunning = false;

function scheduleCasRefresh(
  deps: IdentifyDeps,
  request: PendingCasRefresh,
): void {
  const key = (request.issn || request.name).toLowerCase();
  if (!key) return;
  if (!casRefreshQueue.has(key)) casRefreshQueue.set(key, request);
  void drainCasRefreshQueue(deps);
}

async function drainCasRefreshQueue(deps: IdentifyDeps): Promise<void> {
  if (casRefreshRunning) return;
  casRefreshRunning = true;
  try {
    while (casRefreshQueue.size > 0) {
      const iterator = casRefreshQueue.entries().next();
      if (iterator.done) break;
      const [key, request] = iterator.value;
      casRefreshQueue.delete(key);
      if (!deps.cas || !deps.casStore) break;
      try {
        const result = await deps.cas.lookup({
          name: request.name,
          issn: request.issn,
        });
        if (result.status === "ok" && result.best) {
          const changed = deps.casStore.put(result.best);
          if (changed) deps.onCasUpdated?.(result.best, request.affected);
          await deps.casStore.save();
        }
      } catch (error) {
        deps.log?.("CAS refresh failed", error);
      }
    }
  } finally {
    casRefreshRunning = false;
  }
}
