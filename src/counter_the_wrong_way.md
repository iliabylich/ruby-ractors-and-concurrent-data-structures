# Counter, the wrong way

I'm going to write all data structures here in Rust, and then wrap them with C.

Here's the wrong, non-thread-safe counter struct:

```rust
#[derive(Debug)]
pub struct PlainCounter {
    value: u64,
}

impl PlainCounter {
    // exposed as `PlainCounter.new` in Ruby
    pub fn new(n: u64) -> Self {
        Self { value: n }
    }

    // exposed as `PlainCounter#increment` in Ruby
    pub fn increment(&mut self) {
        self.value += 1;
    }

    // exposed as `PlainCounter#read` in Ruby
    pub fn read(&self) -> u64 {
        self.value
    }
}
```

There's no synchronization internally, and so calling `increment` from multiple threads is simply wrong.

> By the way, you can't mutate it from multiple threads in Rust too. It simply won't compile.

Then we need some glue code to expose these methods to C.

```rust
#[no_mangle]
pub extern "C" fn plain_counter_init(counter: *mut PlainCounter, n: u64) {
    unsafe { counter.write(PlainCounter::new(n)) }
}

#[no_mangle]
pub extern "C" fn plain_counter_increment(counter: *mut PlainCounter) {
    let counter = unsafe { counter.as_mut().unwrap() };
    counter.increment();
}

#[no_mangle]
pub extern "C" fn plain_counter_read(counter: *const PlainCounter) -> u64 {
    let counter = unsafe { counter.as_ref().unwrap() };
    counter.read()
}

pub const PLAIN_COUNTER_SIZE: usize = 8;
```

Why do we need size? That's a part of the C API that we'll use in a moment. Ruby will own our struct, and so it must know its size (but for some reason it doesn't care about alignment, I guess because it always places it at an address that is a multiple of 16 bytes?)

Then we call `bindgen` to generate C headers with 3 functions and one constant.

```c
// rust-atomics.h

// THIS CODE IS AUTO-GENERATED
#define PLAIN_COUNTER_SIZE 8

typedef struct plain_counter_t plain_counter_t;

void plain_counter_init(plain_counter_t *counter, uint64_t n);
void plain_counter_increment(plain_counter_t *counter);
uint64_t plain_counter_read(const plain_counter_t *counter);
```

As you can see we don't even expose internal structure of the `plain_counter_t`, only its size.

Then we can finally write C extension:

```c
// c_atomics.c
#include <ruby.h>
#include "plain-counter.h"

RUBY_FUNC_EXPORTED void Init_c_atomics(void) {
  rb_ext_ractor_safe(true);

  VALUE rb_mCAtomics = rb_define_module("CAtomics");

  init_plain_counter(rb_mCAtomics);
}
```

`c_atomics` is the main file of our extension:

1. first, it calls `rb_ext_ractor_safe` which is **absolutely required** if we want to call functions defined by our C extension from non-main Ractors
2. then, it declares (or re-opens if it's already defined) a module called `CAtomics`
3. and finally it called `init_plain_counter` that is defined in a file `plain-counter.h` see below. We'll have many data structures, so splitting code is a must.

```c
// plain-counter.h
#include "rust-atomics.h"
#include <ruby.h>

const rb_data_type_t plain_counter_data = {
    .function = {
        .dfree = RUBY_DEFAULT_FREE
    },
    .flags = RUBY_TYPED_FROZEN_SHAREABLE
};

VALUE rb_plain_counter_alloc(VALUE klass) {
  plain_counter_t *counter;
  TypedData_Make_Struct0(obj, klass, plain_counter_t, PLAIN_COUNTER_SIZE, &plain_counter_data, counter);
  plain_counter_init(counter, 0);
  VALUE rb_cRactor = rb_const_get(rb_cObject, rb_intern("Ractor"));
  rb_funcall(rb_cRactor, rb_intern("make_shareable"), 1, obj);
  return obj;
}

VALUE rb_plain_counter_increment(VALUE self) {
  plain_counter_t *counter;
  TypedData_Get_Struct(self, plain_counter_t, &plain_counter_data, counter);
  plain_counter_increment(counter);
  return Qnil;
}

VALUE rb_plain_counter_read(VALUE self) {
  plain_counter_t *counter;
  TypedData_Get_Struct(self, plain_counter_t, &plain_counter_data, counter);
  return LONG2FIX(plain_counter_read(counter));
}

static void init_plain_counter(VALUE rb_mCAtomics) {
  VALUE rb_cPlainCounter = rb_define_class_under(rb_mCAtomics, "PlainCounter", rb_cObject);
  rb_define_alloc_func(rb_cPlainCounter, rb_plain_counter_alloc);
  rb_define_method(rb_cPlainCounter, "increment", rb_plain_counter_increment, 0);
  rb_define_method(rb_cPlainCounter, "read", rb_plain_counter_read, 0);
}
```

Here we:

1. Declare metadata of the native data type that will be attached to instances of our `PlainCounter` Ruby class
    1. It has default deallocation logic (because we don't allocate anything on creation)
    2. It's marked as `RUBY_TYPED_FROZEN_SHAREABLE`, this is required or otherwise we'll get an error if we call `Ractor.make_shareable` on it
2. Then there's an allocating function (which basically is what's called when you do `YourClass.allocate`):
    1. It calls `TypedData_Make_Struct0` macro that defines an `obj` variable (the first argument) as an instance of `klass` (second argument) with data of type `plain_counter_t` that has size `PLAIN_COUNTER_SIZE` (the one we generated with `bindgen`) and has metadata `plain_counter_data`. The memory that is allocated and attached to `obj` is stored in the given `counter` argument.
    2. Then we call `plain_counter_init` which goes to Rust and properly initializes our struct with `value = 0`
    3. Then it makes the object Ractor-shareable literally by calling `Ractor.make_shareable(obj)` but in C.
    4. And finally it returns `obj`
3. `rb_plain_counter_increment` and `rb_plain_counter_read` are just wrappers around Rust functions on the native attached data.
4. Finally `init_plain_counter` function defines a `PlainCounter` Ruby class, attaches an allocating function and defines methods `increment` and `read`.

Does this work?

First, single-threaded mode to verify correctness:

```ruby
require 'c_atomics'

counter = CAtomics::PlainCounter.new
1_000.times do
  counter.increment
end
p counter.read
# => 1000
```

Of course it does. Let's try multi-Ractor mode:

```ruby
require 'c_atomics'

COUNTER = CAtomics::PlainCounter.new
ractors = 5.times.map do
  Ractor.new do
    1_000.times { COUNTER.increment }
    Ractor.yield :completed
  end
end
p ractors.map(&:take)
# => [:completed, :completed, :completed, :completed, :completed]
p COUNTER.read
# => 2357
```

That's a race condition, GREAT! Now we understand that it's possible to have objects that are **shareable on the surface but mutable inside**. All we need is to guarantee that internal data structure is synchronized and the key trick here is to use atomic variables and lock-free data structures.

> If you have some experience with Rust and you heard about lock-free data structures it might sound similar to you. Lock-free data structures have the same interface in Rust: they allow mutation through shared references to an object, like this:

```rust
struct LockFreeQueue<T> {
    // ...
}

impl LockFreeQueue<T> {
    fn push(&self, item: T) {
        // ...
    }

    fn pop(&self) -> Option<T> {
        // ...
    }
}
```
