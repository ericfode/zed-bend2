import Base
# <- keyword
#      ^ string.special

type Shape is Data:
# <- keyword
#    ^ type
#             ^ type.builtin
  Circle{r: U32}
# ^ constructor
#        ^ property
#           ^ type.builtin

def area(x: Shape) -> U32:
# <- keyword
#   ^ function
#        ^ variable.parameter
#                  ^ operator
  match x:
# ^ keyword
    case Circle{+r}:
#   ^ keyword
#        ^ constructor
#               ^ operator
      (3 * r * r : U32)
#      ^ number
#        ^ operator

law add_zero:
# <- keyword
#   ^ function
  for x: Nat
# ^ keyword
#     ^ variable.parameter
  {Nat.add(x, 0n) == x : Nat}
#      ^ function
#             ^ number
#                 ^ operator

def proof():
  {==}
#  ^ operator

def unfinished():
  ?TODO
# ^ punctuation.special
#  ^ label

def quantities():
  (&0, &1, &2, Quant, Kind(&1))
#  ^ constant.builtin
#      ^ constant.builtin
#          ^ constant.builtin
#              ^ type.builtin
#                     ^ type.builtin
#                          ^ constant.builtin

def data():
  yes = True{}
#       ^ boolean
  no = False{}
#      ^ boolean
  text = "hello\n"
#        ^ string
#              ^ string.escape
  char = '\t'
#         ^ string.escape
  number = 1.25e-2
#          ^ number
  natural = 42n
#           ^ number
  _ = 0
# ^ variable.special
  ?done

def calls(x: U32):
  local = n => n
#         ^ variable.parameter
#           ^ operator
  Module.compute!(x)
#        ^ function
#               ^ punctuation.special

@unsafe def foreign():
# <- attribute
#       ^ keyword
  import "foreign.c"
# ^ keyword
#         ^ string

def generics():
  List<U32>
# ^ type
#     ^ punctuation.bracket
#         ^ punctuation.bracket

def effects():
  do IO<Unit>:
# ^ keyword
#    ^ type
#      ^ punctuation.bracket
    return Unit{}
#   ^ keyword
#          ^ constructor

def rewrite(proof):
  %proof : Nat
# ^ operator
  {==}

law witness:
  for +x: Nat where {x == x : Nat}
#     ^ operator
#             ^ keyword
  exs y: Nat
# ^ keyword
#     ^ variable.parameter
  {x == y : Nat}

def dependent():
  @+x: Nat -> Nat
# ^ operator
#   ^ variable.parameter
#          ^ operator

def existential():
  &x: Nat -> Nat
# ^ operator
#  ^ variable.parameter

def template(~A: Type, x: A):
#            ^ operator
#             ^ variable.parameter
  function(~(x))
#          ^ operator

def compare(x: U32):
  (x < 2 : U32)
#    ^ operator

# A comment mentioning def, law, and ?TODO stays a comment.
# <- comment
