# Marking

Here comes the tricky part. We do want to call our `push` and `pop` functions using `rb_thread_call_without_gvl` that doesn't acquire an Interpreter Lock and lets GC run in parallel.

What if one thread pushes to the queue the moment GC has finished iterating over it? Well, then it's going to be collected and then Ruby VM will crash really soon once we pop this item from the queue and do something with it (that would be an equivalent of "use-after-free" in languages with manual memory management).

I'm going to go with a non-standard approach here that will probably work with other kinds of containers as well. It looks similar to what's called "quiescent state tracking" (at least in some sources). Briefly:

1. every time we try to `.pop` we register ourselves as a "consumer". It will be an atomic counter that is incemented before the modification of the queue and decremented after.
2. before starting to `.pop` each consumer must make sure that a special atomic boolean flag is not set, and if it's set it must wait, busy-looping is fine here.
3. when marking starts we
    1. enable this flag in order to put other consumers (that are about to start) on "pause"
    2. wait for "consumers" counter to reach 0.
4. at this point we know that no other threads try to mutate our container (existing consumers have finished and no new consumers can start because of the boolean flag), so it's safe to iterate it and call `mark` on each element
5. finally, we set flag back to `false` and unlock other threads

```rust
struct GcGuard {
    // boolean flag
    locked: AtomicBool,
    // number of active consumers
    count: AtomicUsize,
}
```

Initialization is simple, flag is `false` and counter is `0`.

```rust
impl GcGuard {
    pub(crate) fn alloc() -> Self {
        GcGuard {
            locked: AtomicBool::new(false),
            count: AtomicUsize::new(0),
        }
    }

    pub(crate) fn init(&mut self) {
        self.locked.store(false, Ordering::Relaxed);
        self.count.store(0, Ordering::Relaxed);
    }
}
```

Then we need helpers to track and modify the counter:

```rust
impl GcGuard {
    // must be called by every consumer before accessing the data
    fn add_consumer(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }
    // must be called by every consumer after accessing the data
    fn remove_consumer(&self) {
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
    // a method that will be used by "mark" function to wait
    // for the counter to reach zero
    fn wait_for_no_consumers(&self) {
        loop {
            let count = self.count.load(Ordering::SeqCst);
            if count == 0 {
                eprintln!("[producer] 0 running consumers");
                break;
            } else {
                // spin until they are done
                eprintln!("[producer] waiting for {count} consumers to finish");
            }
        }
    }
}
```

> The code in this section uses `SeqCst` but I'm pretty sure `Acquire`/`Release` and `Relaxed` are enough in all cases. I'm intentionally omitting it here for the sake of simplicity.

We can also add helpers for the flag:

```rust
impl GcGuard {
    // must be invoked at the beginning of the "mark" function
    fn lock(&self) {
        self.locked.store(true, Ordering::SeqCst);
    }
    // must be invoked at the end of the "mark" function
    fn unlock(&self) {
        self.locked.store(false, Ordering::SeqCst)
    }
    fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }
    // must be invoked by consumers if they see that it's locked
    fn wait_until_unlocked(&self) {
        while self.is_locked() {
            // spin
        }
    }
}
```

And finally we can write some high-level functions that are called by consumers and the "mark" function:

```rust
impl GcGuard {
    pub(crate) fn acquire_as_gc<F, T>(&self, f: F) -> T
    where
        F: FnOnce() -> T,
    {
        eprintln!("Locking consumers");
        self.lock();
        eprintln!("Waiting for consumers to finish");
        self.wait_for_no_consumers();
        eprintln!("All consumers have finished");
        let out = f();
        eprintln!("Unlocking consumers");
        self.unlock();
        out
    }

    pub(crate) fn acquire_as_consumer<F, T>(&self, f: F) -> T
    where
        F: FnOnce() -> T,
    {
        if self.is_locked() {
            self.wait_until_unlocked();
        }
        self.add_consumer();
        let out = f();
        self.remove_consumer();
        out
    }
}
```

Both take a function as a callback and call it when it's time.

> This pattern definitely can be implemented by returning `GuardAsGc` and `GuardAsConsumer` objects that do unlocking in their destructors, like it's usually implementation in all languages with [RAII](https://en.wikipedia.org/wiki/Resource_acquisition_is_initialization).

Now we can change our `MpmcQueue` to embed and utilize this code:

```rust
struct MpmcQueue {
    // ...
    gc_guard: GcGuard
}

impl MpmcQueue {
    fn alloc() -> Self {
        Self {
            // ...
            gc_guard: GcGuard::alloc(),
        }
    }

    fn init(&mut self, buffer_size: usize, default: c_ulong) {
        // ...
        self.gc_guard.init();
    }

    pub fn pop(&self) -> c_ulong {
        loop {
            // Here's the difference, we wrap `try_pop` with the consumer's lock
            if let Some(data) = self.gc_guard.acquire_as_consumer(|| self.try_pop()) {
                return data;
            }
            self.read_sem.wait();
        }
    }

    // And to mark an object...
    fn mark(&self, mark: extern "C" fn(c_ulong)) {
        // ... we first lock it to prevent concurrent modification
        self.gc_guard.acquire_as_gc(|| {
            // ... and once it's not in use we simply iterate and mark each element
            for item in self.buffer.iter() {
                let value = item.data.get();
                mark(item);
            }
        });
    }
}
```

We can even write [a relatively simple Rust program](https://github.com/iliabylich/ractors-playground/blob/master/rust-atomics/src/bin/mpmc_queue.rs) to see how it works.

1. The code in `GcGuard` prints with `eprintln` that writes to non-buffered `stderr` so the output should be readable.
2. The program spawns 10 threads that try to `.pop` from the queue
3. The main thread spins in a loop that
    1. pushes monotonically increasing numbers to the queue for 1 second
    2. acquires a GC lock
    3. sleeps for 1 second
    4. releases a GC lock
4. At the end we get all values that have been popped and merges them to a single array and then sorts it. In this array each pair of consecutive elements must look like `N` -> `N + 1` and the last element must be equal to the last value that we pushed (i.e. it's a series from 1 to `last_pushed_value`)

In other words, that's a simplified emulation of how GC works. Its output however shows us that it does what we planned:

```
[ThreadId(9)] popped 509
[ThreadId(3)] popped 513
[ThreadId(7)] popped 515
Locking consumers
[ThreadId(5)] popped 517
[ThreadId(8)] popped 516
Waiting for consumers to finish
[producer] waiting for 8 consumers to finish
[producer] waiting for 7 consumers to finish
[producer] waiting for 6 consumers to finish
[ThreadId(10)] popped 519
[ThreadId(4)] popped 520
[producer] waiting for 6 consumers to finish
[producer] waiting for 5 consumers to finish
[ThreadId(11)] popped 518
[producer] waiting for 5 consumers to finish
[producer] waiting for 4 consumers to finish
[ThreadId(6)] popped 522
[producer] waiting for 3 consumers to finish
[ThreadId(9)] popped 523
[ThreadId(3)] popped 524
[producer] waiting for 2 consumers to finish
[producer] waiting for 1 consumers to finish
[ThreadId(2)] popped 521
[producer] waiting for 1 consumers to finish
[ThreadId(7)] popped 525
[producer] 0 running consumers
All consumers have finished
===== GC START ======
===== GC END ========
Unlocking consumers
[ThreadId(7)] popped 528
[ThreadId(4)] popped 534
[ThreadId(3)] popped 532
[ThreadId(11)] popped 529
```

That's exactly what we wanted:

1. first, we lock to prevent new consumers
2. existing consumers however must finish their job
3. the total number of active consumers goes down and once it reaches 0 we mark the queue
4. then we unlock it and let all consumer threads continue
