/**
 * Compatibility facade for the original public analyzer module. New code
 * should import the focused parser, semantic-model, resolver, or workspace
 * modules directly.
 */
export {
  RenameError,
  WorkspaceIndex,
  filePathToUri,
  uriToFilePath,
} from "./workspace-index.mjs";
export { extractEmbeddedDocuments } from "./embedded-documents.mjs";
export { ImportResolver, QuasarResolverPreset } from "./import-resolver.mjs";
export { parseStylus, parserMetadata } from "./parser.mjs";
export { LineMap, offsetAt, positionAt, rangeForOffsets } from "./protocol.mjs";

import { extractEmbeddedDocuments } from "./embedded-documents.mjs";
import { parseStylus } from "./parser.mjs";
import { buildSemanticModel } from "./semantic-model.mjs";

/** Analyze a host document into one semantic model per embedded Stylus region. */
/** @param {string} uri @param {string} text */
export async function analyzeDocument(uri, text) {
  const extracted = await extractEmbeddedDocuments(uri, text);
  const models = [];
  for (const embedded of extracted.documents) {
    const parsed = await parseStylus(embedded.text);
    models.push(await buildSemanticModel(embedded, parsed));
  }
  return {
    uri,
    text,
    regions: extracted.documents.map((embedded) => ({
      start: embedded.hostStart,
      end: embedded.hostEnd,
      attributes: embedded.attributes,
      kind: embedded.kind,
    })),
    definitions: models.flatMap((model) => model.symbols),
    imports: models.flatMap((model) => model.imports),
    models,
    errors: extracted.errors,
  };
}
