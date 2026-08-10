(function_statement
  name: (function_name) @name
  (block)) @definition.function

; Built-in Stylus and CSS functions do not have user definitions to navigate to.
; Keep user-defined calls taggable while avoiding dead go-to-definition results.
((call_expression
  function: (function_name) @name) @reference.call
 (#not-match? @name "^(darken|lighten|saturate|desaturate|adjust-hue|complement|invert|mix|tint|shade|luminosity|contrast|alpha|red|green|blue|unit|lookup|define|operate|match|replace|split|join|push|pop|shift|unshift|slice|length|warn|error|image-size|embedurl|json|selector|selector-exists|prefix-classes|use|blur|brightness|drop-shadow|grayscale|hue-rotate|opacity|sepia)$"))

(extend_statement
  target: (extend_target_list
    (extend_target
      selector: (nested_selector
        (class_name) @name)))) @reference.class

(extend_statement
  target: (extend_target_list
    (extend_target
      selector: (nested_selector
        (id_name) @name)))) @reference.class

(extend_statement
  target: (extend_target_list
    (extend_target
      selector: (nested_selector
        (placeholder_selector) @name)))) @reference.class

(extend_statement
  target: (extend_target_list
    (extend_target
      selector: (nested_selector
        (tag_name) @name)))) @reference.class

(assignment
  left: (variable_name) @name) @definition.constant

(block_assignment
  left: (variable_name) @name) @definition.constant

(parameter
  name: (variable_name) @name) @definition.constant

(each_statement
  item: (identifier) @name) @definition.constant

(each_statement
  index: (identifier) @name) @definition.constant

(for_statement
  item: (identifier) @name) @definition.constant

(for_statement
  index: (identifier) @name) @definition.constant

(postfix_for_clause
  item: (identifier) @name) @definition.constant

(postfix_for_clause
  index: (identifier) @name) @definition.constant

(expression
  (variable_name) @name) @reference.constant

(member_expression
  object: (variable_name) @name) @reference.constant

(defined_expression
  value: (variable_name) @name) @reference.constant

(property_lookup) @name @reference.constant

(rule_set
  selector: (selector_list
    (selector
      (tag_name) @name))) @definition.class

(rule_set
  selector: (nested_selector_list
    (nested_selector
      (tag_name) @name))) @definition.class

(rule_set
  selector: (selector_list
    (selector
      (class_name) @name))) @definition.class

(rule_set
  selector: (nested_selector_list
    (nested_selector
      (class_name) @name))) @definition.class

(rule_set
  selector: (selector_list
    (selector
      (id_name) @name))) @definition.class

(rule_set
  selector: (nested_selector_list
    (nested_selector
      (id_name) @name))) @definition.class

(rule_set
  selector: (selector_list
    (selector
      (placeholder_selector) @name))) @definition.class

(rule_set
  selector: (nested_selector_list
    (nested_selector
      (placeholder_selector) @name))) @definition.class

(rule_set
  selector: (selector_list
    (selector
      (selector_interpolation) @name))) @definition.class

(rule_set
  selector: (nested_selector_list
    (nested_selector
      (selector_interpolation) @name))) @definition.class

(keyframes_statement
  name: (keyframes_name) @name) @definition.class

(keyframes_statement
  name: (interpolation) @name) @definition.class
