; Function definitions
(function_statement
  name: (function_name) @name
  parameters: (parameters) @context
  (block)) @item

; Rule sets capture the full selector list so grouped, nested, interpolated,
; attribute, pseudo, and nesting selectors all appear in the outline.
(rule_set
  selector: (selector_list) @name) @item

(rule_set
  selector: (nested_selector_list) @name) @item

; Keyframes
(keyframes_statement
  name: (keyframes_name) @name) @item

(keyframes_statement
  name: (interpolation) @name) @item

; Media queries
(media_statement
  query: (_) @name) @item

; Supports queries
(supports_statement
  query: (_) @name) @item

; Generic and literal at-rules
(generic_at_rule
  name: (at_keyword) @name) @item

(css_literal_statement
  "@css" @name) @item

; Font-face blocks
(font_face_statement
  keyword: (at_keyword) @name) @item

; @import statements
(import_statement
  source: (string_value) @name) @item

; Variable declarations at root level
(stylesheet
  (assignment
    left: (variable_name) @name) @item)

(stylesheet
  (block_assignment
    left: (variable_name) @name) @item)
