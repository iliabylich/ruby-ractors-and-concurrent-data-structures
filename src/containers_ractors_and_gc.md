# Containers, Ractors, and GC

Remember: we are here to build concurrent data structures, not just plain counters. What are containers in high-level programming languages with managed memory? They are still "normal" containers that hold **references** to other objects, in other words an array of data objects is not a blob of memory with objects located one after another, it's a blob of **pointers** to those objects.

Objects in Ruby are represented using `VALUE` type which is just an `unsigned long` C type that is a 64-bit unsigned integer. In fact it's a tagged pointer where **top bits** define what is this `VALUE` and **low bits** represent the actual value.

Just like in other interpreted languages small integers, `true`, `false`, `nil` and some other values are represented with a special pattern of bits that can be checked using special macros `FIXNUM_P`, `NIL_P` and others. Also it means that "not every object in Ruby is passed by reference" but that's a separate topic.

So an object that we want to store in our containers is a number, `std::ffi::c_ulong` to be more specific. Ok, sounds good so far, but two questions immediately pop into my head.

## 1. Can we have containers that allow us to temporarily get a reference to stored objects?

Here's an example:

```ruby
COLLECTION = SomeThreadSafeStruct.new

r1 = Ractor.new { COLLECTION.get(key).update(value) }
r2 = Ractor.new { COLLECTION.get(key).update(value) }
```

This is basically a race condition. I see two options:

1. we can definitely have data structures that DON'T allow "borrowing" of any value from the inside. An example of such data structure would be a queue, `.push(value)` "moves" the value to the queue and nobody else in this thread can access it anymore. `.pop` "moves" the value from the queue back to the user code. This way we can guarantee that only one thread accesses each element at any point in time. Unfortunately there's no way to enforce it but it could be done safely on the level of a single library that uses this queue internally.
2. we can definitely have data structures that only store other concurrent values, then we can safely "borrow" them

For 1 here's a rough equivalent of the code:

```ruby
QUEUE = SafeQueue.new

N.times do
  Ractor.new do
    process(QUEUE.pop)
  end
end

DATA.each do |value|
  QUEUE.push(value)
end

# However you can't get nth element of the queue, e.g.
# QUEUE[3] or QUEUE.peek or QUEUE.last is not allowed
```

For 2 I think something like this is very doable:

```ruby
# All keys are Ractor-shareable
KEYS = Ractor.make_shareable(["key-1", "key-2", "key-3"])

METRICS = SafeHashMap.new

KEYS.each do |key|
  METRICS[key] = SafeCounter.new
end

N.times do
  Ractor.new do
    METRICS[KEYS.sample].increment
  end
end
```

This code is safe because keys are frozen and values are thread-safe objects that have a static lifetime (i.e. they live through the whole lifetime of the program)

IMO anything else is not really possible unless you write code in a certain way that guarantees the lack of race conditions (which is possible but definitely fragile).

## 2. How does it work when GC runs in parallel?

This is a tricky question and I should start from the scratch. When GC starts, it iterates over Ractors and acquires an Interpreter Lock for each of them. We can demonstrate it with a simple code:

```rs
use std::{ffi::c_ulong, time::Duration};

pub struct SlowObject {
    n: u64,
}

impl SlowObject {
    fn alloc() -> Self {
        Self { n: 0 }
    }

    fn init(&mut self, n: u64) {
        self.n = n;
    }

    fn mark(&self, _: extern "C" fn(c_ulong)) {
        eprintln!("[mark] started");
        std::thread::sleep(Duration::from_secs(2));
        eprintln!("[mark] finished");
    }

    fn slow_op(&self) {
        eprintln!("[slow_op] started");
        for i in 1..=10 {
            eprintln!("tick {i}");
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("[slow_op] finished");
    }
}
```

I'm not sure if an integer field here is required but as I remember C doesn't support zero-sized structs, so that's just a way to guarantee that things are going to work.

This struct has:

1. a `mark` callback that will be called by Ruby GC to mark its internals and it takes 2 seconds to run, so basically if we have N objects of this class on the heap GC will take at least `2*N` seconds to run
2. a `slow_op` method that prints `tick <N>` 10 times with a 100ms delay (so it takes a second to run)

Then we'll define these 2 methods in the C extension:

```c
VALUE rb_slow_object_slow_op(VALUE self) {
  slow_object_t *slow;
  TypedData_Get_Struct(self, slow_object_t, &slow_object_data, slow);
  slow_object_slow_op(slow);
  return Qnil;
}

VALUE rb_slow_object_slow_op_no_gvl_lock(VALUE self) {
  slow_object_t *slow;
  TypedData_Get_Struct(self, slow_object_t, &slow_object_data, slow);
  rb_thread_call_without_gvl(slow_object_slow_op, slow, NULL, NULL);
  return Qnil;
}

static void init_slow_object(VALUE rb_mCAtomics) {
  VALUE rb_cSlowObject = rb_define_class_under(rb_mCAtomics, "SlowObject", rb_cObject);
  // ...
  rb_define_method(rb_cSlowObject, "slow_op", rb_slow_object_slow_op, 0);
  rb_define_method(rb_cSlowObject, "slow_op_no_gvl_lock", rb_slow_object_slow_op_no_gvl_lock, 0);
}
```

When we run the following code first (note that it calls `slow_op` that does acquire an Interpreter Lock) Ruby waits for our Rust method to return control to Ruby:

```ruby
slow = CAtomics::SlowObject.new(42)
Ractor.new(slow) do |slow|
  5.times { slow.slow_op }
  Ractor.yield :done
end
5.times { GC.start; sleep 0.1 }
```

With this code we see the following repeating pattern:

```
[mark] started
[mark] finished
[slow_op] started
tick 1
tick 2
tick 3
tick 4
tick 5
tick 6
tick 7
tick 8
tick 9
tick 10
[slow_op] finished
[mark] started
[mark] finished
````

Which means that GC waits for our `slow_op` method to finish its looping, so normally Ruby DOES NOT run your code in parallel to GC. But what if we call `slow_op_no_gvl_lock`?

```ruby
slow = CAtomics::SlowObject.new(42)
Ractor.new(slow) do |slow|
  5.times { slow.slow_op_no_gvl_lock }
  Ractor.yield :done
end
5.times { GC.start; sleep 0.1 }
```

Now our `slow_op` function runs in parallel:

```
[mark] started
[mark] finished
[slow_op] started
tick 1
tick 2
[mark] started
tick 3
tick 4
tick 5
tick 6
tick 7
tick 8
tick 9
tick 10
[slow_op] finished
[mark] finished
[slow_op] started
tick 1
tick 2
[mark] started
tick 3
```

### bonus question: what about GC compaction?

Starting from Ruby 3.0 there's a new step of GC called "compaction". It's a process of moving Ruby objects from one place to another (similar to "file system defragmentation"). How can we keep Ruby object addresses in our structure AND at the same time support their potential moving?

Turns out there's an API for that, it's called `rb_gc_location`. This function is called during compaction step and for any given "old" address of an object it returns a "new" one, so we can simply iterate over our data structure and do `element = rb_gc_location(element)`.
