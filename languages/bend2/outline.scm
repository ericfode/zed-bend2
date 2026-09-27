(function_definition
  "def" @context
  name: (_) @name
  parameters: (parameters) @context) @item

(law_declaration
  "law" @context
  name: (_) @name) @item

(type_declaration
  "type" @context
  name: (_) @name) @item

(constructor_declaration
  name: (_) @name) @item
