; Comments
(comment) @comment

; Keywords
[
  "if"
  "unless"
  "else"
  "each"
  "for"
  "while"
  "return"
  "in"
  "is"
  "and"
  "or"
  "not"
  "only"
  "defined"
] @keyword

[
  "import"
  "require"
  "@import"
  "@require"
  "media"
  "@media"
  "supports"
  "@supports"
  "keyframes"
  "@keyframes"
  "extend"
  "@extend"
  "extends"
  "@extends"
  "@block"
  "@css"
] @keyword

(at_keyword) @keyword
(media_query_keyword) @keyword

; Literals
(boolean_value) @constant.builtin
(null_value) @constant.builtin
(integer_value) @number
(float_value) @number
(unit) @type @type.builtin
(color_value) @string.special
(string_value) @string
(escape_sequence) @string.escape

; Names
(variable_name
  (identifier) @variable)

(variable_name
  (dollar_identifier) @variable.special)

(property_lookup) @variable.special

(parameter
  name: (variable_name
    (identifier) @variable.parameter))

(parameter
  name: (variable_name
    (dollar_identifier) @variable.parameter))

(property_name) @property
(tag_name) @tag
(class_name) @type
(selector_suffix) @type
(id_name) @type
(placeholder_selector) @type
(attribute_name) @attribute
(pseudo_class) @attribute
(pseudo_element) @attribute
(keyframes_name) @label

; Structured captures
(function_statement
  name: (function_name) @function)

((call_expression
  function: (function_name) @function)
 (#not-match? @function "^(darken|lighten|saturate|desaturate|adjust-hue|complement|invert|mix|tint|shade|luminosity|contrast|alpha|red|green|blue|unit|lookup|define|operate|match|replace|split|join|push|pop|shift|unshift|slice|length|warn|error|image-size|embedurl|json|selector|selector-exists|prefix-classes|use|blur|brightness|drop-shadow|grayscale|hue-rotate|opacity|sepia)$"))

((call_expression
  function: (function_name) @function @function.builtin)
 (#match? @function.builtin "^(darken|lighten|saturate|desaturate|adjust-hue|complement|invert|mix|tint|shade|luminosity|contrast|alpha|red|green|blue|unit|lookup|define|operate|match|replace|split|join|push|pop|shift|unshift|slice|length|warn|error|image-size|embedurl|json|selector|selector-exists|prefix-classes|use|blur|brightness|drop-shadow|grayscale|hue-rotate|opacity|sepia)$"))

(css_function_expression
  function: (function_name) @function @function.builtin)

(interpolated_property_name
  (property_name) @property)

(each_statement
  item: (identifier) @variable)

(each_statement
  index: (identifier) @variable)

(for_statement
  item: (identifier) @variable)

(for_statement
  index: (identifier) @variable)

(postfix_for_clause
  item: (identifier) @variable)

(postfix_for_clause
  index: (identifier) @variable)

(raw_css_value) @string.special

(optional_modifier) @keyword
(important_modifier) @keyword

(universal_selector) @tag
(nesting_selector) @punctuation.special
(combinator) @punctuation.delimiter
(deep_combinator) @punctuation.special
(is_a_operator) @operator
(is_not_operator) @operator

(attribute_selector
  operator: [
    "="
    "~="
    "^="
    "|="
    "*="
    "$="
  ] @operator)

; Interpolation
(interpolation
  [
    "#{"
    "{"
  ] @punctuation.special
  "}" @punctuation.special)

(selector_interpolation
  [
    "#{"
    "{"
  ] @punctuation.special
  "}" @punctuation.special)

; Operators
[
  "="
  "?="
  ":="
  "+="
  "-="
  "*="
  "/="
  "%="
  "!"
  "=="
  "!="
  "isnt"
  "<"
  ">"
  "<="
  ">="
  "+"
  "-"
  "~"
  "*"
  "/"
  "%"
  "**"
  "?"
  "&&"
  "||"
  ".."
  "..."
] @operator

; Punctuation
[
  "("
  ")"
  "["
  "]"
] @punctuation.bracket

[
  ":"
  ","
] @punctuation.delimiter
