import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { identifyItem, type MinimalItem } from "../src/modules/identify";
import type { CasJournalEntry } from "../src/modules/cas/types";
import { mergeExtra } from "../src/modules/record";

/**
 * The identification pipeline with a stubbed journal cache.
 *
 * Covers the two halves of the 中科院分区 requirement: a journal that is already
 * cached gets its zone immediately, and a journal that is not cached schedules a
 * background look-up instead of blocking the identification.
 */

const OPTIONS = {
  dblpEnabled: false,
  casEnabled: true,
  casCacheTtlDays: 30,
  aliasMapping: "[]",
};

/** The CAS look-up is only attempted when a client is available. */
function makeCasClient() {
  return {
    calls: [] as Array<{ name?: string; issn?: string }>,
    async lookup(query: { name?: string; issn?: string }) {
      this.calls.push(query);
      return { status: "not-found" as const, hits: [] };
    },
  };
}

function makeItem(
  fields: Record<string, string>,
  itemType = "journalArticle",
): MinimalItem & { fields: Record<string, string> } {
  return {
    id: 1,
    libraryID: 1,
    itemType,
    fields,
    getField: (field: string) => fields[field] ?? "",
    isRegularItem: () => true,
    isNote: () => false,
    isAttachment: () => false,
    getNotes: () => [],
  };
}

function makeEntry(overrides: Partial<CasJournalEntry> = {}): CasJournalEntry {
  return {
    issn: "0162-8828",
    name: "IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE",
    abbr: "IEEE T PATTERN ANAL",
    zone: "1区",
    fetchedAt: Date.now(),
    origin: "letpub",
    ...overrides,
  };
}

interface StoreStub {
  lookups: Array<{ name: string; issn?: string }>;
  puts: CasJournalEntry[];
  /** Whether a journal is cached. */
  enabled: boolean;
  lookup(
    name: string,
    issn?: string,
  ): { entry: CasJournalEntry; fresh: boolean } | undefined;
  put(entry: CasJournalEntry): boolean;
  save(): Promise<void>;
}

function makeStore(entry?: CasJournalEntry, fresh = true): StoreStub {
  let current = entry;
  const store: StoreStub = {
    lookups: [],
    puts: [],
    enabled: entry !== undefined,
    lookup(name: string, issn?: string) {
      store.lookups.push({ name, issn });
      if (!current) return undefined;
      return { entry: current, fresh };
    },
    put(next: CasJournalEntry) {
      store.puts.push(next);
      current = next;
      return true;
    },
    async save() {
      // nothing to persist in the test
    },
  };
  return store;
}

/** A DBLP client that always returns one hit for the requested title. */
function makeDblp(venuePath: string, title: string) {
  const path = `${venuePath.replace(/^\/+/, "")}/record`;
  return {
    async lookup() {
      return {
        status: "ok" as const,
        hits: [{ path, venuePath, title, url: path }],
      };
    },
  };
}

describe("identifyItem: CAS lookup", () => {
  it("uses the cached zone for a journal", async () => {
    const store = makeStore(makeEntry());
    const item = makeItem({
      title: "Attention Is All You Need",
      publicationTitle:
        "IEEE Transactions on Pattern Analysis and Machine Intelligence",
      ISSN: "0162-8828",
    });

    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });

    equal(result.record.ccf, "A");
    equal(result.record.ccfVenue, "TPAMI");
    equal(result.record.cas, "1区");
    equal(result.record.venueType, "journal");
    equal(store.lookups.length, 1, "the cache is consulted once");
    equal(result.casRefreshScheduled, false, "a fresh entry is not refreshed");
  });

  it("schedules a background look-up for an unknown journal", async () => {
    const store = makeStore(undefined);
    const item = makeItem({
      title: "Some Recent Paper",
      publicationTitle: "Journal of Brand New Studies",
    });
    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });
    // The network look-up is queued, not awaited: give the queue a moment.
    await new Promise((resolve) => setTimeout(resolve, 30));
    equal(cas.calls.length, 1, "the background look-up ran");
    equal(cas.calls[0].name, "Journal of Brand New Studies");

    equal(result.casRefreshScheduled, true);
    ok(result.notes.includes("cas:scheduled"));
    equal(store.lookups.length, 1);
    equal(store.lookups[0].name, "Journal of Brand New Studies");
  });

  it("never looks up a CAS zone for a conference paper", async () => {
    const store = makeStore(makeEntry());
    const item = makeItem(
      {
        title: "Deep Residual Learning for Image Recognition",
        proceedingsTitle:
          "Proceedings of the 2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)",
        conferenceName:
          "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
      },
      "conferencePaper",
    );

    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });

    equal(result.record.ccfVenue, "CVPR");
    equal(result.record.venueType, "conference");
    equal(result.record.cas, undefined);
    equal(store.lookups.length, 0, "conferences are skipped structurally");
    equal(result.casRefreshScheduled, false);
  });

  it("never looks up a CAS zone for a preprint", async () => {
    const store = makeStore(makeEntry());
    const item = makeItem(
      {
        title: "Scaling Laws for Neural Language Models",
        repository: "arXiv",
        publicationTitle: "arXiv",
      },
      "preprint",
    );

    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });

    equal(result.record.venueType, "preprint");
    equal(result.record.ccfVenue, "arXiv");
    equal(store.lookups.length, 0);
  });

  it("keeps the journal rank when DBLP only knows the arXiv version", async () => {
    // DBLP indexes the preprint of a paper that is still under review at
    // TKDE, so the CoRR hit must not overwrite a venue the item names itself.
    const item = makeItem({
      title:
        "EAIFD: A Fast and Scalable Algorithm for Incremental Functional Dependency Discovery",
      publicationTitle: "TKDE",
      date: "2026-01-18",
    });

    const result = await identifyItem(item, {
      dblp: makeDblp("/journals/corr", item.fields.title) as never,
      options: { ...OPTIONS, dblpEnabled: true },
    });

    equal(result.record.ccf, "A");
    equal(result.record.ccfVenue, "TKDE");
    equal(result.record.venueType, "journal");
    equal(result.record.source, "metadata");
    ok(result.notes.includes("dblp:preprint-ignored"));
  });

  it("falls back to a DBLP preprint hit when the item names no venue", async () => {
    const item = makeItem(
      { title: "A Paper Without A Venue Yet" },
      "manuscript",
    );

    const result = await identifyItem(item, {
      dblp: makeDblp("/journals/corr", "A Paper Without A Venue Yet") as never,
      options: { ...OPTIONS, dblpEnabled: true },
    });

    equal(result.record.venueType, "preprint");
    equal(result.record.ccfVenue, "arXiv");
    ok(result.notes.includes("dblp:preprint"));
  });

  it("identifies an under-review preprint from the user's publication field", async () => {
    // Filed as a preprint (repository arXiv) but the publication field names
    // the target journal: the journal wins over the preprint verdict.
    const item = makeItem(
      {
        title: "A Paper Under Review",
        repository: "arXiv",
        publicationTitle: "TKDE",
      },
      "preprint",
    );

    const result = await identifyItem(item, { options: OPTIONS });

    equal(result.record.ccf, "A");
    equal(result.record.ccfVenue, "TKDE");
    equal(result.record.venueType, "journal");
  });

  it("falls back to the item's journal fields when the venue matched as a journal path", async () => {
    const store = makeStore(makeEntry());
    // No publicationTitle at all: the catalog match has to supply the name.
    const item = makeItem({
      title: "A paper about pattern analysis",
      ISSN: "0162-8828",
    });

    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });

    // Without a journal name there is nothing to look up locally ...
    equal(store.lookups.length, 1);
    ok(
      store.lookups[0].issn === "0162-8828" || store.lookups[0].name.length > 0,
      "either the ISSN or a name must reach the cache",
    );
    void result;
  });

  it("writes the record into the Extra field", async () => {
    const store = makeStore(makeEntry());
    const item = makeItem({
      title: "Attention Is All You Need",
      publicationTitle:
        "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    });
    const cas = makeCasClient();
    const result = await identifyItem(item, {
      casStore: store as never,
      cas: cas as never,
      options: OPTIONS,
    });
    const extra = mergeExtra("Citation Key: vaswani2017", result.record);
    ok(extra.startsWith("Citation Key: vaswani2017"));
    ok(extra.includes("CCF-RANK: A"));
    ok(extra.includes("CAS-ZONE: 1区"));
    ok(extra.includes("VENUE-TYPE: journal"));
  });
});
