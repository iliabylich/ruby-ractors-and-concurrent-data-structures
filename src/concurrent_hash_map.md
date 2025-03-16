# Concurrent HashMap

We are already using Rust at this point, so can we just take a popular Rust package that implements it? Of course, I'm going to use [`dashmap`](https://crates.io/crates/dashmap). Internally it locks individual buckets (or shards if you prefer) when we access certain parts of the hashmap.

```rs
use std::ffi::c_ulong;

struct ConcurrentHashMap {
    map: dashmap::DashMap<c_ulong, c_ulong>,
}

impl ConcurrentHashMap {
    // Exposed as `ConcurrentHashMap.new` in Ruby
    fn new() -> Self {
        Self {
            map: dashmap::DashMap::new(),
        }
    }

    // Exposed as `ConcurrentHashMap#get` in Ruby
    fn get(&self, key: c_ulong) -> Option<c_ulong> {
        self.map.get(&key).map(|v| *v)
    }

    // Exposed as `ConcurrentHashMap#set` in Ruby
    fn set(&self, key: c_ulong, value: c_ulong) {
        self.map.insert(key, value);
    }

    // Exposed as `ConcurrentHashMap#clear` in Ruby
    fn clear(&self) {
        self.map.clear()
    }

    // Exposed as `ConcurrentHashMap#fetch_and_modify` in Ruby
    fn fetch_and_modify(&self, key: c_ulong, f: extern "C" fn(c_ulong) -> c_ulong) {
        self.map.alter(&key, |_, v| f(v));
    }

    // Callback for marking an object
    // Exposed as `concurrent_hash_map_mark` in C
    fn mark(&self, f: extern "C" fn(c_ulong)) {
        for pair in self.map.iter() {
            f(*pair.key());
            f(*pair.value());
        }
    }
}
```

`mark` function is used as `.dmark` field in our native type configuration:

```c
void rb_concurrent_hash_map_mark(void *ptr) {
  concurrent_hash_map_t *hashmap = ptr;
  concurrent_hash_map_mark(hashmap, rb_gc_mark);
}

const rb_data_type_t concurrent_hash_map_data = {
    .function = {
        .dmark = rb_concurrent_hash_map_mark,
        // ...
    },
    // ...
};
```

The trick for `fetch_and_modify` is to pass `rb_yield` function that calls block of the current scope with a given value and returns whatever the block returns:

```c
VALUE rb_concurrent_hash_map_fetch_and_modify(VALUE self, VALUE key) {
  rb_need_block();
  concurrent_hash_map_t *hashmap;
  TypedData_Get_Struct(self, concurrent_hash_map_t, &concurrent_hash_map_data, hashmap);
  concurrent_hash_map_fetch_and_modify(hashmap, key, rb_yield);
  return Qnil;
}
```

Then we can add a few helper functions in Ruby:

```ruby
class CAtomics::ConcurrentHashMap
  def self.with_keys(known_keys)
    map = new
    known_keys.each { |key| map.set(key, 0) }
    map
  end

  def increment_random_value(known_keys)
    fetch_and_modify(known_keys.sample) { |v| v + 1 }
  end

  def sum(known_keys)
    known_keys.map { |k| get(k) }.sum
  end
end
```

It's definitely not the best interface, but it works for testing.

```ruby
KEYS = 1.upto(5).map { |i| "key-#{i}" }
# => ["key-1", "key-2", "key-3", "key-4", "key-5"]
Ractor.make_shareable(KEYS)

MAP = CAtomics::ConcurrentHashMap.with_keys(KEYS)

ractors = 5.times.map do
  Ractor.new do
    1_000.times { MAP.increment(KEYS.sample) }
    Ractor.yield :completed
  end
end
p ractors.map(&:take)
# => [:completed, :completed, :completed, :completed, :completed]

MAP.sum(KEYS)
# => 5000
```

Wait, why do the values increment correctly? Shouldn't the values inside the hashmap be atomic as well? No, this is actually fine, the code is correct. `DashMap` locks individual parts of our hashmap every time we call `fetch_and_modify` and so no threads can update the same key/value pair in parallel.

There are two problems with our API though

## it's unsafe

anyone can get a reference to any object from `.get` or keep what they pass to `.set` for future use. I see no solutions other than keeping it private with a HUGE note saying "this is actually internal, WE know how to use it, you don't" or simply not introducing such API at all.

## does it work with non-static Ruby values?

I think it doesn't respect Ruby's `.hash` and `.eql?` methods and works only if you pass the same object again (one of the frozen static `KEYS`), so in some sense it works as if we called `compare_by_identity` on it.

Let's fix it! First, there are two C functions that we need to call from our C code:

```c
unsafe extern "C" {
    fn rb_hash(obj: c_ulong) -> c_ulong;
    fn rb_eql(lhs: c_ulong, rhs: c_ulong) -> c_int;
}
```

The first one returns a hash of the given as a Ruby number. We don't care about it, any value is fine. The second one calls `lhs == rhs` using Ruby method dispatch and returns non-zero if the objects are equal. For `DashMap` we need to implement a few Rust traits to call them properly:

```rs
// This is our wrapper type that uses Ruby functions for `.hash` and `.eql?`
#[derive(Debug)]
struct RubyHashEql(c_ulong);

impl PartialEq for RubyHashEql {
    fn eq(&self, other: &Self) -> bool {
        unsafe { rb_eql(self.0, other.0) != 0 }
    }
}
impl Eq for RubyHashEql {}

impl std::hash::Hash for RubyHashEql {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        let ruby_hash = unsafe { rb_hash(self.0) };
        ruby_hash.hash(state);
    }
}

struct ConcurrentHashMap {
    // And here is the change, so now the keys are hashed and compared using Ruby functions
    map: dashmap::DashMap<RubyHashEql, c_ulong>,
}
```

Is it better now?

```ruby
Point = Struct.new(:x, :y)

map = CAtomics::ConcurrentHashMap.new

map.set(Point.new("one-point-two", "seven"), "BAR")
map.get(Point.new("one-point-two", "seven"))
# => "BAR"
```
