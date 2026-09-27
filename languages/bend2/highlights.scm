; Adapted from amaanq/tree-sitter-bend; see THIRD_PARTY_NOTICES.md.
; Use Zed's standard captures and regex predicates (not Neovim's lua-match?).

(identifier) @variable

((identifier) @variable.special
  (#eq? @variable.special "_"))

((identifier) @type
  (#match? @type "^[A-Z][A-Za-z0-9_]*$"))

((identifier) @type.builtin
  (#any-of? @type.builtin
    "Empty" "Unit" "Bool" "Cmp" "Either" "Sigma" "Pair" "Nat" "U32" "F32"
    "Char" "String" "Maybe" "Result" "List" "Word" "Array" "Map" "Set"
    "Equal" "IO" "Chan" "File" "Socket" "Listener" "Window" "Audio"
    "Image" "Event" "App"))

; Declarations and binding sites.
(function_definition
  name: [
    (identifier) @function
    (scoped_identifier (identifier) @function .)
  ])

(law_declaration
  name: [
    (identifier) @function
    (scoped_identifier (identifier) @function .)
  ])

(type_declaration
  name: [
    (identifier) @type
    (scoped_identifier (identifier) @type .)
  ])

(constructor_declaration
  name: [
    (identifier) @constructor
    (scoped_identifier (identifier) @constructor .)
  ])

(field_declaration name: (identifier) @property)
(parameter name: (identifier) @variable.parameter)
(for_clause name: (identifier) @variable.parameter)
(exists_clause name: (identifier) @variable.parameter)
(lambda parameter: (identifier) @variable.parameter)
(dependent_function_type name: (identifier) @variable.parameter)
(exists_type name: (identifier) @variable.parameter)
(decorator) @attribute

(import_declaration path: (import_path) @string.special)
(import_declaration alias: (identifier) @type)

; Types, quantities, constructors, and calls.
(type_application
  name: [
    (identifier) @type
    (scoped_identifier (identifier) @type .)
  ])

(kind ["Type" "Data" "Quant" "Kind"] @type.builtin)
(quantity) @constant.builtin

(do_block
  monad: [
    (identifier) @type
    (scoped_identifier (identifier) @type .)
  ])

(constructor
  name: [
    (identifier) @constructor
    (scoped_identifier (identifier) @constructor .)
  ])

(constructor_pattern
  name: [
    (identifier) @constructor
    (scoped_identifier (identifier) @constructor .)
  ])

(match_arm
  name: [
    (identifier) @constructor
    (scoped_identifier (identifier) @constructor .)
  ])

((constructor name: (identifier) @boolean)
  (#any-of? @boolean "True" "False"))

((constructor_pattern name: (identifier) @boolean)
  (#any-of? @boolean "True" "False"))

(call
  function: [
    (identifier) @function
    (scoped_identifier (identifier) @function .)
  ])

(call
  function: (type_application
    name: [
      (identifier) @function
      (scoped_identifier (identifier) @function .)
    ]))

(call "!" @punctuation.special)
(hole "?" @punctuation.special name: (identifier) @label)

; Literals and comments.
(string) @string
(char) @string
(escape_sequence) @string.escape
[(integer) (natural) (float)] @number
(comment) @comment

[
  "def" "law" "type" "match" "case" "do" "return"
  "import" "as" "for" "exs" "where" "is"
] @keyword

[
  "&" "|" "||" "&&" "<" "<=" ">" ">=" "<>" "++" "<&>"
  ".|." ".^." ".&." "<<" ">>" "+" "-" "*" "/" "%" "^"
  "==" "!=" "=" "<-" "->" "=>" "@" "~"
] @operator

["(" ")" "[" "]" "{" "}" "\\{"] @punctuation.bracket

(type_application ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
(do_block ["<" ">"] @punctuation.bracket)

["," ":" ";"] @punctuation.delimiter
(scoped_identifier "." @punctuation.delimiter)
