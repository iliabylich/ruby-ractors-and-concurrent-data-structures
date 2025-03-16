# Intro

This story is about concurrent data structures in the context of Ruby. The goal here is to demonstrate how true parallelism can be achieved with global mutable state (which at the moment of writing is not supported by built-in Ruby primitives).

Familiarity with Ruby, Rust, C (and a bit of other tooling) is nice to have, but hopefully not mandatory.

The repository with code examples can be found [on GitHub](https://github.com/iliabylich/ractors-playground), to run it you need a relatively new version of Ruby (master branch is probably the best option if you can compile it locally), Rust and C compilers.
