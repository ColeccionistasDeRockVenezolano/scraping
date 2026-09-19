// CRV · Ficha de otro tipo: la ficha no es lo que dice ser.
//
// Casos reales del estudio (2026-09-16): 146 personas con el nombre exacto de
// una organización («Capitol Studios», «KMS Records»), 22 personas que son una
// duración («3:48», «9'11»), «en vivo, Caracas June 2001», «Demo», «Live»,
// bandas cargadas como persona («Laberinto», «Arkangel») y «Fundación Nuevas
// Bandas» como artista.
import { classifyPersonName, looksLikeOrganization } from "../../review/person-junk.js";
import { isPersonShaped, keyTokens, nameKey } from "../lexicon.js";
import { isLowercaseNonName, nameFinding, quote, type Detector } from "./shared.js";

const CATEGORY = "ficha_de_otro_tipo";

/** Marcadores inequívocos: los aprendidos débiles pueden ser nombres de banda. */
const STRONG_ORGANIZATION_MARKERS = new Set([
  "records", "record", "discos", "sello", "label",
  "estudio", "estudios", "studio", "studios",
  "produccion", "producciones", "production", "productions",
  "fundacion", "foundation",
]);
/** Fichas agregadoras que tampoco son artistas. */
const NON_ARTIST_PLACEHOLDERS = new Set(["compilado", "compilation", "varios", "various"]);

export const personIsOrganization: Detector = {
  key: "persona_es_organizacion",
  category: CATEGORY,
  label: "Persona que es una organización",
  description: "Estudios, sellos o productoras cargados como persona: coinciden con una organización del catálogo o usan su vocabulario (aprendido de los nombres de organización).",
  actions: {
    coincide_con_organizacion: ["convertir_en_organizacion_existente"],
    vocabulario_de_organizacion: ["convertir_creando_organizacion"],
  },
  run(context) {
    return context.names.filter((name) => name.kind === "person").flatMap((name) => {
      const orgIds = context.lexicon.organizationsByKey.get(nameKey(name.value)) ?? [];
      if (orgIds.length) {
        return [nameFinding(this, name, {
          signature: "coincide_con_organizacion", signatureLabel: "Mismo nombre que una organización",
          severity: "high",
          title: `Se llama igual que la organización ${quote(context.organizations.get(orgIds[0]!)?.name ?? name.value)}`,
          suggestion: "Fusionar con la organización o convertir la ficha en organización",
          related: orgIds.map((id) => ({ kind: "organization" as const, id, label: context.organizations.get(id)?.name ?? String(id) })),
        })];
      }
      const tokens = keyTokens(name.value);
      let markers = tokens.filter((token) => context.lexicon.organizationMarkers.has(token));
      // Una marca aprendida que cierra un nombre con forma de persona es un
      // apellido («Dan Warner», «John Philips»), no el sello. Las palabras
      // inequívocas («Records», «Estudios») siguen marcando: «Arturo Records».
      if (markers.length === 1 && markers[0] === tokens.at(-1) && tokens.length >= 2 && isPersonShaped(context.lexicon, name.value)) markers = [];
      if (!markers.length && !looksLikeOrganization(name.value)) return [];
      return [nameFinding(this, name, {
        signature: "vocabulario_de_organizacion", signatureLabel: "Vocabulario de sello o estudio",
        severity: "medium",
        title: markers.length ? `Usa palabras propias de organizaciones: ${markers.map(quote).join(", ")}` : "Contiene una palabra de estudio, sello o productora",
        suggestion: "Convertir la ficha en organización",
        evidence: { learnedMarkers: markers },
      })];
    });
  },
};

const YEAR = /\b(?:19|20)\d{2}\b/u;

export const personIsNotAName: Detector = {
  key: "persona_no_es_un_nombre",
  category: CATEGORY,
  label: "Persona que no es un nombre",
  description: "Duraciones, números, fragmentos de texto, palabras de rol o de tipo de disco, o texto de un evento cargados como persona.",
  actions: { "*": ["retirar_con_creditos"] },
  run(context) {
    // Rol, tipo de disco o descriptor de género/serie («Rock», «Vol»): ninguno es un nombre.
    const generic = (token: string): boolean => context.lexicon.roleTokens.has(token) || context.lexicon.albumTypeWords.has(token)
      || context.lexicon.descriptorTokens.has(token);
    return context.names.filter((name) => name.kind === "person").flatMap((name) => {
      const classification = classifyPersonName(name.value);
      const tokens = keyTokens(name.value);
      if (classification.kind === "duration") {
        return [nameFinding(this, name, {
          signature: "duracion_o_numero", signatureLabel: "Duración o número", severity: "high",
          title: `${quote(name.value)} es una duración o un número, no una persona`,
          suggestion: "Retirar la ficha o pasar el valor a la duración de la pista",
        })];
      }
      if (classification.kind === "fragment" && (name.value.trim().length < 3 || /^(tema|part|track|cara|lado)\b/iu.test(name.value.trim()))) {
        return [nameFinding(this, name, {
          signature: "fragmento", signatureLabel: "Fragmento de texto", severity: "high",
          title: "Fragmento de texto cargado como persona", suggestion: "Retirar la ficha o dividirla en el dato real",
        })];
      }
      const key = ` ${tokens.join(" ")} `;
      const mentionsPlace = [...context.lexicon.places].some((place) => key.includes(` ${place} `));
      if ((YEAR.test(name.value) && tokens.length >= 3) || (mentionsPlace && tokens.some((token) => context.lexicon.albumTypeWords.has(token) || context.lexicon.descriptorTokens.has(token)))) {
        return [nameFinding(this, name, {
          signature: "texto_de_evento", signatureLabel: "Texto de un evento o grabación", severity: "high",
          title: "Parece la descripción de una grabación o un evento, no una persona",
          suggestion: "Retirar la ficha y llevar el dato a la nota del disco o la pista",
          evidence: { learnedTokens: tokens.filter(generic) },
        })];
      }
      if (tokens.length > 0 && (tokens.every(generic) || context.lexicon.places.has(tokens.join(" ")))) {
        return [nameFinding(this, name, {
          signature: "palabra_generica", signatureLabel: "Palabra de rol, tipo o lugar", severity: "high",
          title: `${quote(name.value)} es una palabra de rol, de tipo de disco o de lugar, no un nombre`,
          suggestion: "Retirar la ficha o convertirla en el dato que describe",
          evidence: { learnedTokens: tokens },
        })];
      }
      if (isLowercaseNonName(context.lexicon, name)) {
        return [nameFinding(this, name, {
          signature: "fragmento", signatureLabel: "Fragmento de texto", severity: "high",
          title: "Texto en minúsculas sin ninguna palabra de nombre de persona: es un fragmento, no un nombre",
          suggestion: "Retirar la ficha o llevar el texto a la nota del disco o la pista",
          evidence: { lowercase: true },
        })];
      }
      return [];
    });
  },
};

export const personNamedLikeArtist: Detector = {
  key: "persona_con_nombre_de_artista",
  category: CATEGORY,
  label: "Persona con el nombre de un artista",
  description: "Una ficha de persona se llama exactamente como un artista del catálogo y no tiene ningún vínculo con él: la banda cargada como persona, o el solista detrás de un proyecto con su nombre.",
  actions: {
    solista_detras_del_proyecto: ["vincular_como_miembro", "convertir_en_artista"],
    banda_como_persona: ["convertir_en_artista", "vincular_como_miembro"],
  },
  run(context) {
    return context.names.filter((name) => name.kind === "person").flatMap((name) => {
      const artists = context.lexicon.artistsByKey.get(nameKey(name.value)) ?? [];
      const linked = context.snapshot.personArtists.get(name.id) ?? new Set<number>();
      const unlinked = artists.filter((artist) => !linked.has(artist.id));
      if (!artists.length || unlinked.length !== artists.length) return [];
      // B5: con forma de nombre de persona («Angel Rada», «Claudio Corsi») casi
      // siempre es el solista que publica con su nombre: se vincula como
      // miembro. Sin ella («Kreils», «Los Supersónicos») es la banda como persona.
      const soloist = isPersonShaped(context.lexicon, name.value);
      return [nameFinding(this, name, {
        signature: soloist ? "solista_detras_del_proyecto" : "banda_como_persona",
        signatureLabel: soloist ? "Solista con proyecto a su nombre" : "La banda cargada como persona",
        severity: soloist ? "low" : "medium",
        title: soloist
          ? `Se llama igual que el artista ${quote(unlinked[0]!.name)}: parece el solista detrás del proyecto y no está vinculado a él`
          : `Se llama igual que el artista ${quote(unlinked[0]!.name)} y no está vinculada a él: parece la banda cargada como persona`,
        suggestion: soloist
          ? "Vincular la persona como miembro del artista; si en realidad es la banda, reemplazar sus créditos por el artista"
          : "Reemplazar los créditos de la persona por el artista; si es la persona detrás del proyecto, vincularla como miembro",
        related: unlinked.map((artist) => ({ kind: "artist" as const, id: artist.id, label: artist.name })),
        evidence: { personShaped: soloist },
      })];
    });
  },
};

export const artistIsOrganization: Detector = {
  key: "artista_es_organizacion",
  category: CATEGORY,
  label: "Artista que es una organización",
  description: "Un artista con el nombre exacto de una organización o con vocabulario de sello, fundación o estudio.",
  run(context) {
    return context.names.filter((name) => name.kind === "artist").flatMap((name) => {
      const orgIds = context.lexicon.organizationsByKey.get(nameKey(name.value)) ?? [];
      const tokens = keyTokens(name.value);
      const learnedMarkers = tokens.filter((token) => context.lexicon.organizationMarkers.has(token));
      const markers = learnedMarkers.filter((token) => STRONG_ORGANIZATION_MARKERS.has(token));
      const placeholder = tokens.find((token) => NON_ARTIST_PLACEHOLDERS.has(token));
      if (!orgIds.length && !markers.length && !placeholder) return [];
      return [nameFinding(this, name, {
        signature: orgIds.length ? "coincide_con_organizacion" : "vocabulario_de_organizacion",
        signatureLabel: orgIds.length ? "Mismo nombre que una organización" : "Vocabulario de sello o estudio",
        severity: orgIds.length ? "medium" : "low",
        title: orgIds.length
          ? `Se llama igual que la organización ${quote(context.organizations.get(orgIds[0]!)?.name ?? name.value)}`
          : placeholder
            ? `Parece una ficha agregadora, no un artista: ${quote(placeholder)}`
            : `Usa palabras propias de organizaciones: ${markers.map(quote).join(", ")}`,
        suggestion: "Confirmar si es un artista o la organización (sello, fundación, estudio)",
        related: orgIds.map((id) => ({ kind: "organization" as const, id, label: context.organizations.get(id)?.name ?? String(id) })),
        evidence: { learnedMarkers, strongMarkers: markers, ...(placeholder ? { placeholder } : {}) },
      })];
    });
  },
};

export const MISTYPED_DETECTORS: Detector[] = [personIsOrganization, personIsNotAName, personNamedLikeArtist, artistIsOrganization];
