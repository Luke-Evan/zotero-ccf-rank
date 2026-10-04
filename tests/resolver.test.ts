import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { ccfRankList, notableVenues } from "../src/data/ccfCatalog";
import {
  formatCcfLabel,
  getUserAliases,
  matchVenueByIssn,
  matchVenueName,
  resolveVenueFromCandidates,
} from "../src/modules/venue/resolver";
import { collectVenueCandidates } from "../src/modules/venue/itemFields";

function item(fields: Record<string, string>, itemType = "journalArticle") {
  return {
    itemType,
    getField: (field: string) => fields[field] ?? "",
  };
}

describe("catalog integrity", () => {
  it("has CCF entries with a rank, abbreviation and full name", () => {
    const paths = Object.keys(ccfRankList);
    ok(paths.length > 600, `expected a full catalog, got ${paths.length}`);
    for (const path of paths) {
      const entry = ccfRankList[path];
      ok(/^[ABC]$/.test(entry.rank), `${path} rank`);
      ok(entry.abbr.length > 0, `${path} abbr`);
      ok(entry.full.length > 0, `${path} full`);
    }
  });

  it("keeps notable venues unique", () => {
    const paths = notableVenues.flatMap((venue) => venue.paths);
    equal(new Set(paths).size, paths.length);
  });
});

describe("venue matching from metadata", () => {
  it("matches full journal names", () => {
    const match = matchVenueName(
      "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    );
    equal(match?.kind, "ccf");
    equal(match?.ccf, "A");
    equal(match?.abbr, "TPAMI");
  });

  it("matches journal abbreviations", () => {
    const match = matchVenueName("IEEE Trans. Pattern Anal. Mach. Intell.");
    equal(match?.ccf, "A");
    equal(match?.abbr, "TPAMI");
  });

  it("matches conference abbreviations", () => {
    equal(matchVenueName("CVPR")?.ccf, "A");
    equal(matchVenueName("NeurIPS")?.ccf, "A");
    equal(matchVenueName("ICSE")?.ccf, "A");
    equal(matchVenueName("SIGCOMM")?.ccf, "A");
  });

  it("matches a conference name with edition, year and location", () => {
    const variants = [
      "Proceedings of the 2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)",
      "2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition, Seattle, WA, USA",
      "IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR 2024)",
      "The 41st IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    ];
    for (const variant of variants) {
      equal(matchVenueName(variant)?.abbr, "CVPR", variant);
    }
  });

  it("matches the spelled-out name of a systems conference", () => {
    const match = matchVenueName(
      "27th ACM Symposium on Operating Systems Principles",
    );
    equal(match?.abbr, "SOSP");
    equal(match?.ccf, "A");
  });

  it("matches notable venues that are not in the CCF catalog", () => {
    const match = matchVenueName("Conference on Language Modeling");
    equal(match?.kind, "notable");
    equal(match?.abbr, "COLM");
    equal(match?.ccf, undefined);
  });

  it("prefers the journal whose raw name matches over a higher ranked collision", () => {
    // The normalized keys drop generic words, so these journals collide with
    // conferences of the same topic. Ranking by CCF level alone used to pick the
    // conference and report a journal article as "CCF-A ACM MM".
    const cases: Array<[string, string, string]> = [
      ["IEEE Transactions on Multimedia", "TMM", "/journals/tmm"],
      ["Machine Learning", "ML", "/journals/ml"],
      ["IEEE Transactions on Software Engineering", "TSE", "/journals/tse"],
      ["International Journal of Computer Vision", "IJCV", "/journals/ijcv"],
    ];
    for (const [name, abbr, path] of cases) {
      const match = resolveVenueFromCandidates([name], [], "journal");
      equal(match?.abbr, abbr, name);
      equal(match?.path, path, name);
    }
  });

  it("still picks the conference when the item is a conference paper", () => {
    equal(
      resolveVenueFromCandidates(["ACM Multimedia"], [], "conference")?.abbr,
      "ACM MM",
    );
    equal(
      resolveVenueFromCandidates(
        ["IEEE International Conference on Computer Vision"],
        [],
        "conference",
      )?.abbr,
      "ICCV",
    );
  });

  it("matches CCF venues whose names consist only of generic words", () => {
    // "Journal of the ACM" and "Proceedings of the IEEE" normalize to nothing
    // when the generic words are dropped, which used to make them unmatchable.
    const cases: Array<[string, string, string]> = [
      ["Journal of the ACM", "JACM", "A"],
      ["Proceedings of the IEEE", "Proc. IEEE", "A"],
      ["Proc. IEEE", "Proc. IEEE", "A"],
      ["ACM SIGMOD Conference", "SIGMOD", "A"],
      ["Communications of the ACM", "CACM", "A"],
    ];
    for (const [name, abbr, rank] of cases) {
      const match = resolveVenueFromCandidates([name], [], "journal");
      equal(match?.abbr, abbr, name);
      equal(match?.ccf, rank, name);
    }
  });

  it("does not invent a rank for an unknown venue", () => {
    equal(matchVenueName("Journal of Totally Unrelated Studies"), undefined);
    equal(matchVenueName(""), undefined);
  });

  it("formats the CCF label", () => {
    equal(
      formatCcfLabel({
        kind: "ccf",
        ccf: "A",
        abbr: "TPAMI",
        confidence: 1,
        strategy: "x",
      }),
      "CCF-A TPAMI",
    );
    equal(
      formatCcfLabel(
        { kind: "ccf", ccf: "A", abbr: "TPAMI", confidence: 1, strategy: "x" },
        false,
      ),
      "A TPAMI",
    );
  });
});

describe("candidate collection and resolution", () => {
  it("reads the field that matches the item type", () => {
    const journal = collectVenueCandidates(
      item({
        publicationTitle: "IEEE Transactions on Computers",
        ISSN: "0018-9340",
      }),
    );
    equal(journal.kindHint, "journal");
    ok(journal.values.includes("IEEE Transactions on Computers"));
    equal(journal.issn, "0018-9340");

    const conference = collectVenueCandidates(
      item(
        {
          proceedingsTitle:
            "Proceedings of the 2024 ACM SIGCOMM Conference (SIGCOMM '24)",
          conferenceName: "ACM SIGCOMM 2024",
        },
        "conferencePaper",
      ),
    );
    equal(conference.kindHint, "conference");
    ok(conference.values.length >= 2);
  });

  it("recognizes preprints", () => {
    const preprint = collectVenueCandidates(
      item({ repository: "arXiv", publicationTitle: "arXiv" }, "preprint"),
    );
    equal(preprint.flags.isPreprint, true);
    equal(preprint.kindHint, "preprint");
  });

  it("prefers the venue the user entered on a preprint item", () => {
    // A paper under review is often filed as a preprint while its
    // "Publication" field already names the target journal.
    const underReview = collectVenueCandidates(
      item({ repository: "arXiv", publicationTitle: "TKDE" }, "preprint"),
    );
    equal(underReview.flags.isPreprint, false);
    equal(underReview.kindHint, "journal");
    equal(underReview.namedVenue, "TKDE");
    equal(resolveVenueFromCandidates(underReview.values)?.abbr, "TKDE");
  });

  it("picks the ranked match out of several candidates", () => {
    const match = resolveVenueFromCandidates([
      "Some Unknown Workshop",
      "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    ]);
    equal(match?.abbr, "TPAMI");
  });
});

describe("user aliases", () => {
  it("parses valid JSON only", () => {
    equal(getUserAliases("not json").length, 0);
    equal(getUserAliases(undefined).length, 0);
    const aliases = getUserAliases(
      JSON.stringify([
        { match: "My Fancy Workshop", abbr: "MFW", ccf: "B", cas: "3区" },
        { match: "Bad rank", ccf: "Z" },
        { notAMatch: true },
      ]),
    );
    equal(aliases.length, 2);
    equal(aliases[0].ccf, "B");
    equal(aliases[1].ccf, undefined);
  });

  it("matches user aliases and lets them win with high confidence", () => {
    const aliases = getUserAliases(
      JSON.stringify([
        { match: "Journal of Fancy Studies", abbr: "JFS", ccf: "C" },
      ]),
    );
    const match = matchVenueName("Journal of Fancy Studies", aliases);
    equal(match?.abbr, "JFS");
    equal(match?.ccf, "C");
    equal(match?.strategy, "alias");
  });

  it("resolves a journal by ISSN through an alias", () => {
    const aliases = getUserAliases(
      JSON.stringify([{ match: "1234-5678", abbr: "JTEST", ccf: "B" }]),
    );
    equal(matchVenueByIssn("1234-5678", aliases)?.abbr, "JTEST");
    equal(matchVenueByIssn("9999-0000", aliases), undefined);
  });
});
