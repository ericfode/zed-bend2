# Bend2 highlighting showcase (syntax fixture, not a type-checked program).
import Base
import ./support.bend as Support

type Shape is Data:
  Circle{r: U32}
  Square{s: U32}

def area(x: Shape) -> U32:
  match x:
    case Circle{+r}:
      (3 * r * r : U32)
    case Square{+s}:
      (s * s : U32)

type Box<A: Type> is Type:
  Box{value: A}

def identity(~A: Type, x: A) -> A:
  x

def literals():
  text = "Bend2\n\u{1f600}"
  char = '\t'
  float = 1.25e-2
  items = [0n, 1n, 42n]
  yes = True{}
  no = False{}
  (text, char, float, items, yes, no)

def arrays(+seed: U32):
  values = [seed : U32*8n]
  values[0n] <- 42
  values[0n]

def quantities():
  (&0, &1, &2, Quant, Kind(&1))

def calls(x: U32):
  square = +n => (n * n : U32)
  mapped = List.map<U32>(~(square), [x])
  Support.compute!(mapped)

def effects() -> IO<Unit>:
  do IO<Unit>:
    line: String <- IO.read_line()
    IO<Unit> <- IO.print(line)
    return Unit{}

law add_zero:
  for x: Nat
  {Nat.add(x, 0n) == x : Nat}

law witness:
  for +x: Nat where {x == x : Nat}
  exs y: Nat
  {x == y : Nat}

def add_zero(x: Nat):
  match x:
    case 0n:
      {==}
    case 1n+p:
      %add_zero(p) : {Nat.add(1n+p, 0n) == 1n+p : Nat}
      {==}

def unfinished():
  ?TODO

@unsafe def foreign():
  import "support.c"
