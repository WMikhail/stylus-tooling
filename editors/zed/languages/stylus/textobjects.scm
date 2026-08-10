; Functions
(function_statement
  (block (_)* @function.inside)) @function.around

; Rule sets behave like class-like blocks in stylesheet motions
(rule_set
  (block (_)* @class.inside)) @class.around

(rule_set) @class.around

; Common at-rules that wrap nested blocks
(media_statement
  (block (_)* @class.inside)) @class.around

(media_statement) @class.around

(supports_statement
  (block (_)* @class.inside)) @class.around

(supports_statement) @class.around

(keyframes_statement
  (block (_)* @class.inside)) @class.around

(keyframes_statement) @class.around

(font_face_statement
  (block (_)* @class.inside)) @class.around

(font_face_statement) @class.around

(generic_at_rule
  (block (_)* @class.inside)) @class.around

(generic_at_rule) @class.around

(css_literal_statement
  (css_declaration_block (_)* @class.inside)) @class.around

(css_literal_statement) @class.around

; Comments
(comment)+ @comment.around
