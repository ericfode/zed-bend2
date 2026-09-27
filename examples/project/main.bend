import Base
import ./math.bend as Math

# Navigate from increment to math.bend, or from result to its local binding.
def main() -> U32:
  result = Math.increment(41)
  result
