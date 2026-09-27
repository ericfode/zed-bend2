(function_definition
  body: (block) @function.inside) @function.around

(law_declaration
  body: (block) @function.inside) @function.around

(type_declaration
  body: (block)? @class.inside) @class.around

(comment)+ @comment.around
