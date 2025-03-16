# (Naive) Concurrent Queue

A queue is an absolutely must-have structure for concurrent applications:

1. a queue of requests can be used to route traffic to multiple worker threads
2. a queue of tests can be used by a test framework to route them to worker threads
3. a queue of background jobs that are executed by worker threads

First, let's build a simple, I would even say a "naive" version of the queue that is simply wrapped with a `Mutex`.

Oh, it must have a fixed maximum size, we don't want to open the door for DDoSing, right?

Here's a fixed-size queue that is **not** thread-safe:

```rust
use std::{collections::VecDeque, ffi::c_ulong};

struct UnsafeQueue {
    queue: VecDeque<c_ulong>,
    cap: usize,
}

impl UnsafeQueue {
    // Equivalent of `.allocate` method
    fn alloc() -> Self {
        Self {
            queue: VecDeque::new(),
            cap: 0,
        }
    }

    // Equivalent of a constructor
    fn init(&mut self, cap: usize) {
        self.cap = cap;
    }

    // A method to push a value to the queue
    // THIS CAN FAIL if the queue is full, and so it must return a boolean value
    fn try_push(&mut self, value: c_ulong) -> bool {
        if self.queue.len() < self.cap {
            self.queue.push_back(value);
            true
        } else {
            false
        }
    }

    // A method to pop a value from the queue
    // THIS CAN FAIL if the queue is empty
    fn try_pop(&mut self) -> Option<c_ulong> {
        self.queue.pop_front()
    }

    // A convenient helper for GC marking
    fn for_each(&self, f: extern "C" fn(c_ulong)) {
        for item in self.queue.iter() {
            f(*item);
        }
    }
}
```

Here we use Rust's built-in type called `VecDeque` that has `push_back` and `pop_front` method, plus it handles:

1. the cases when the size of the queue exceeds the specified size (then `false` is returned from `try_push`)
2. when we pop from an empty queue (then `None` is returned from the `pop` method)

Now we wrap it with a `Mutex`:

```rust
// Exposed as `QueueWithMutex` class in Ruby
pub struct QueueWithMutex {
    inner: Mutex<UnsafeQueue>,
}

impl QueueWithMutex {
    // Exposed as `QueueWithMutex.allocate` class in Ruby
    fn alloc() -> Self {
        Self {
            inner: Mutex::new(UnsafeQueue::alloc()),
        }
    }

    // Exposed as `QueueWithMutex#initialize` class in Ruby
    fn init(&mut self, cap: usize) {
        let mut inner = self.inner.lock();
        inner.init(cap);
    }

    // GC marking logic
    fn mark(&self, f: extern "C" fn(c_ulong)) {
        let inner = self.inner.lock();
        inner.for_each(f);
    }

    // Exposed as `QueueWithMutex#try_push` class in Ruby
    fn try_push(&self, value: c_ulong) -> bool {
        if let Some(mut inner) = self.inner.try_lock() {
            if inner.try_push(value) {
                return true;
            }
        }
        false
    }

    // Exposed as `QueueWithMutex#try_pop` class in Ruby
    fn try_pop(&self) -> Option<c_ulong> {
        if let Some(mut inner) = self.inner.try_lock() {
            if let Some(value) = inner.try_pop() {
                return Some(value);
            }
        }

        None
    }
}
```

As you can see it's a semi-transparent wrapper around `UnsafeQueue`, except that each operation on it first tries to acquire a lock on a `Mutex` and if it fails it also returns `false` or `None`, so our `try_push` and `try_pop` methods can now also fail because another thread holds a lock.

To escape Rust-specific `Option<T>` abstraction we can simply make a wrapping function take an additional `fallback` argument that is returned is the value of `Option` is `None`:

```rust
#[no_mangle]
pub extern "C" fn queue_with_mutex_try_pop(queue: *mut QueueWithMutex, fallback: c_ulong) -> c_ulong {
    let queue = unsafe { queue.as_mut().unwrap() };
    queue.try_pop().unwrap_or(fallback)
}
```

How can we safely `push` and `pop` in a blocking manner? Well, here for simplicty let's just add methods that retry `try_push` and `try_pop` in a loop, with a short `sleep` if it fails.

```ruby
class QueueWithMutex
  class Undefined
    def inspect
      "#<Undefined>"
    end
  end
  UNDEFINED = Ractor.make_shareable(Undefined.new)

  def pop
    loop do
      value = try_pop(UNDEFINED)
      if value.nil?
        return nil
      elsif value.equal?(UNDEFINED)
        # continue
      else
        return value
      end
      sleep 0.001
    end
  end

  def push(value)
    loop do
      pushed = try_push(value)
      return if pushed
      sleep 0.001
    end
  end
end
```

Here a special unique `UNDEFINED` object takes place of the `fallback` value that we use to identify absence of the value. This implementation is naive, but for now that's the goal (later, we'll implement a more advanced queue that doesn't rely on polling.).

Time to test it:

```ruby
QUEUE = CAtomics::QueueWithMutex.new(10)

1.upto(5).map do |i|
  puts "Starting worker..."

  Ractor.new(name: "worker-#{i}") do
    puts "[#{Ractor.current.name}] Starting polling..."
    while (popped = QUEUE.pop) do
      puts "[#{Ractor.current.name}] #{popped}"
      sleep 3
    end
  end
end

value_to_push = 1
loop do
  QUEUE.push(value_to_push)
  sleep 0.5 # push twice a second to make workers "starve" and enter the polling loop
  value_to_push += 1
end
```

The output is the following (which means that it works!):

```
Starting worker...
Starting worker...
[worker-1] Starting polling...
Starting worker...
[worker-2] Starting polling...
Starting worker...
[worker-3] Starting polling...
Starting worker...
[worker-4] Starting polling...
[worker-5] Starting polling...
[worker-5] 1
[worker-2] 2
[worker-4] 3
[worker-1] 4
[worker-3] 5
[worker-5] 6
[worker-2] 7
[worker-4] 8
[worker-1] 9
// ...
```

What's interesting, this queue implementation is enough for use-cases where somewhat bad latency of starving workers is insignificant (because if the queue has items then `.pop` will immediately succeed in most cases). An example that I see is a test framework IF your individual tests are not trivial (i.e. take more than a microsecond).
