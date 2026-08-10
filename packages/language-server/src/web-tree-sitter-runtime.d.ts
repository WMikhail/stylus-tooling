/** Missing from web-tree-sitter@0.25.x's published declarations. */
interface EmscriptenModule {
  locateFile?: (fileName: string, directory: string) => string;
  [option: string]: unknown;
}
