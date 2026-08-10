/**
 * Tree-sitter query used as the syntax-to-semantics boundary. Structural
 * interpretation (scope ownership and shadowing) lives in semantic-model.mjs.
 */
export const SEMANTIC_QUERY = String.raw`
(assignment left: (variable_name) @definition.variable)
(block_assignment left: (variable_name) @definition.variable)
(function_statement name: (function_name) @definition.callable)
(parameter name: (variable_name) @definition.parameter)
(each_statement item: (identifier) @definition.loop)
(each_statement index: (identifier) @definition.loop)
(for_statement item: (identifier) @definition.loop)
(for_statement index: (identifier) @definition.loop)
(postfix_for_clause item: (identifier) @definition.loop)
(postfix_for_clause index: (identifier) @definition.loop)
(keyframes_statement name: (keyframes_name) @definition.keyframes)
(rule_set selector: (_) @definition.selector-container)
(import_statement source: (string_value) @import.source)
(call_expression function: (function_name) @reference.callable)
(variable_name) @reference.variable
(extend_target selector: (_) @reference.extend)
(ERROR) @syntax.error
`;
