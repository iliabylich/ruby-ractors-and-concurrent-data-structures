# Conclusion

1. It's definitely possible to write true multi-threaded apps in Ruby with global mutable state
2. Existing primitives are not enough but nothing stops you from bringing your own
3. This kind of code can be "kindly borrowed" from other languages and packaged as independent Ruby libraries
4. Writing concurrent data structures is hard but it doesn't have to be repeated in every app, we can reuse code
5. I hope that much of what's been explained in this article is applicable not only to Ruby, but to other languages with limited conccurency primitives (e.g. Python/JavaScript)
