import { describe, it } from "vitest";
import { buildContext } from "../../src/curation/analyze.js";
import {
  organizationTypeVsName,
  albumWithoutTracks,
  missingDurationsInTimedAlbum,
  sustainedUppercase,
} from "../../src/curation/detectors/advanced.js";
import { loadCatalogFixture } from "../support/curation-catalog-fixture.js";

describe("sonda temporal E11 sobre foto real", () => {
  it("imprime una muestra reproducible para etiquetar el corpus", () => {
    const context = buildContext(loadCatalogFixture());
    const detectors = [organizationTypeVsName, albumWithoutTracks, missingDurationsInTimedAlbum, sustainedUppercase];
    const payload = Object.fromEntries(detectors.map((detector) => {
      const findings = detector.run(context);
      return [detector.key, {
        count: findings.length,
        sample: findings.slice(0, 30).map((finding) => ({
          entity: finding.entity,
          signature: finding.signature,
          value: finding.value ?? null,
          title: finding.title,
          suggestedValue: finding.suggestedValue ?? null,
        })),
      }];
    }));
    process.stdout.write(`E11_PROBE=${JSON.stringify(payload)}\n`);
  });
});
