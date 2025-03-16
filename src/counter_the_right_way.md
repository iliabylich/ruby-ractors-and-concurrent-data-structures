# Counter, the right way

Okay, at this point we know that instead of a plain integer we need to use an atomic int and we should use `Ordering::Relaxed` to `fetch_add` and `load` it.

> Starting from this section, I'll omit the part with C functions, instead there will be only comments like "Exposed as XXX in Ruby"

```rs
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub struct AtomicCounter {
    value: AtomicU64,
}

impl AtomicCounter {
    // Exposed as `AtomicCounter.new` in Ruby
    pub fn new(n: u64) -> Self {
        Self {
            value: AtomicU64::new(n),
        }
    }

    // Exposed as `AtomicCounter#increment` in Ruby
    pub fn increment(&self) {
        self.value.fetch_add(1, Ordering::Relaxed);
    }

    pub fn read(&self) -> u64 {
        self.value.load(Ordering::Relaxed)
    }
}
```

The main question is "does it actually work?". First, single-threaded code

```ruby
require 'c_atomics'

counter = CAtomics::AtomicCounter.new
1_000.times do
  counter.increment
end
p counter.read
# => 1000
```

Great, it works. Time for multi-threaded code:

```ruby
require 'c_atomics'

COUNTER = CAtomics::AtomicCounter.new
ractors = 5.times.map do
  Ractor.new do
    1_000.times { COUNTER.increment }
    Ractor.yield :completed
  end
end
p ractors.map(&:take)
# => [:completed, :completed, :completed, :completed, :completed]
p COUNTER.read
# => 5000
```

Isn't it great?
