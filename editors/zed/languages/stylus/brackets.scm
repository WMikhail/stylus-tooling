; Parentheses (function calls, arguments, conditions)
("(" @open ")" @close)

; Square brackets (attribute selectors, lists)
("[" @open "]" @close)

; Interpolation brackets
("#{" @open "}" @close)
("{" @open "}" @close)
