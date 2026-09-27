("(" @open ")" @close)
("[" @open "]" @close)
("{" @open "}" @close)
(match_expression "\\{" @open "}" @close)

; Only type arguments use angle brackets; comparisons and shifts do not.
(type_application "<" @open ">" @close)
(type_parameters "<" @open ">" @close)
(do_block "<" @open ">" @close)

((string "\"" @open "\"" @close) (#set! rainbow.exclude))
((char "'" @open "'" @close) (#set! rainbow.exclude))
