// CRV · Fichas sin vínculos: nada del catálogo las referencia.
//
// Estudio (2026-09-16): 279 personas, 307 organizaciones y 79 artistas sin un
// solo disco, crédito, membresía o sello. Suelen ser restos de fusiones y
// retiros, o fichas creadas por una extracción que luego se corrigió.
import type { Finding } from "../types.js";
import { nameFinding, type Detector } from "./shared.js";

const NOUN = {
  person: { one: "Persona", many: "Personas" },
  organization: { one: "Organización", many: "Organizaciones" },
  artist: { one: "Artista", many: "Artistas" },
} as const;

export const unlinkedRecords: Detector = {
  key: "fichas_sin_vinculos",
  category: "fichas_sin_vinculos",
  label: "Fichas que nada referencia",
  description: "Personas sin créditos ni membresías, organizaciones que no son sello ni crédito de nada, artistas sin discos ni créditos.",
  actions: { "*": ["retirar_huerfana"] },
  run(context) {
    const links = {
      person: context.snapshot.personLinks,
      organization: context.snapshot.organizationLinks,
      artist: context.snapshot.artistLinks,
    } as const;
    const out: Finding[] = [];
    for (const name of context.names) {
      if (name.kind !== "person" && name.kind !== "organization" && name.kind !== "artist") continue;
      if ((links[name.kind].get(name.id) ?? 0) > 0) continue;
      out.push(nameFinding(this, name, {
        signature: name.kind, signatureLabel: `${NOUN[name.kind].many} sin vínculos`,
        severity: "low",
        title: `${NOUN[name.kind].one} sin ningún vínculo en el catálogo`,
        suggestion: "Vincularla a lo que corresponda, fusionarla con su ficha real o retirarla",
      }));
    }
    return out;
  },
};

export const ORPHAN_DETECTORS: Detector[] = [unlinkedRecords];
