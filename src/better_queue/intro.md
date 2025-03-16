# A Better Queue

To implement a "better" version of the queue we need to:

1. get rid of the loop-until-succeeds logic in Ruby, in theory we can move it to Rust, but then it means that GC will be blocked while we are inside our blocking `pop` method that loops until it succeeds.
2. to avoid it we must call our function with `rb_thread_call_without_gvl` and on top of that it cannot lock GC
3. but it means that we'll have parallel access to our data structure by threads that `push/pop` and by the thread that runs GC (which is the main thread).

The latter sounds like something that can't be achieved because it's clearly a race condition. We want to have a data structure that:

1. supports parallel non-blocking modification
2. AND iteration by other thread in parallel (to mark each item of the queue)

And IF, just IF we make a mistake and don't mark a single object that is still in use then the whole VM crashes.

Here starts the fun part about lock-free data structures.

> Lock-free data structures are about providing a guarantee that at least one thread is able to make a progress at any point in time.

There's also a term "wait-free data structures" that means that **all** threads can make progress and don't block each other, and that every operation requires a constant (potentially large but constant) number of steps to complete. In practice it's a rare beast and from what I know most of the time they are slower than lock-free alternative implementations.

A famous example of a lock-free data structure is a spinlock mutex:

```rs
struct Spinlock<T> {
    data: T,
    in_use: AtomicBool
}

impl<T> Spinlock<T> {
    fn new(data: T) -> Self {
        Self {
            data,
            in_use: AtomicBool::new(false)
        }
    }

    fn try_lock(&self) -> bool {
        self.in_use.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_ok()
    }

    fn lock(&self) {
        loop {
            if self.try_lock() {
                // swapped from "not in use" to "in use"
                return;
            }
        }
    }

    fn unlock(&self) {
        self.in_use.compare_exchange(true, false, Ordering::Release, Ordering::Relaxed)
    }
}
```

> Please ignore unsafety of the interface, yes, there should be a concept of a Guard object

`try_lock` method is lock-free. It tries to compare-and-exchange value of `in_use` from `false` (not in use) to `true` (in use by current thread). If it succeeds `true` is returned.

To lock an object in a blocking manner we spin and keep trying to lock it. Once it succeeds we know that we own the object until we call `unlock`.

Unlocking is done by the thread that owns it, and so it's guaranteed still to be `true`; no looping is needed. Once we compare-exchange it from `true` to `false` we lose ownership and some other thread spinning in parallel can get access now.

This kind of locking is totally acceptable if you don't have high contention and if you lock for a short period of time. No syscall is needed and if you spin only a few times on average it should be faster than a syscall-based approach.

In the next chapter we'll use a lock-free, multi-producer, multi-consumer queue and then we'll wrap it with a somewhat efficient blocking interface.
