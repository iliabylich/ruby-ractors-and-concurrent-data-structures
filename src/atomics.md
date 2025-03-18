# Atomics

> SPOILER: I'm not an expert in this area and if you are really interested in learning how atomics work better read something else.
>
> If you are comfortable with Rust I would personally recommend ["Rust Atomics and Locks" by Mara Bos](https://marabos.nl/atomics/)
>
> I'll do my best to explain what I know but please take it with a grain of salt.

When I say "atomics" I mean atomic variables. In Rust there's a set of data types representing atomic variables, e.g. `std::sync::atomic::AtomicU64`. They can be modified using atomic operations like `fetch_add` and `compare_and_swap` and the change that happens is always atomic.

Internally they rely on a set of special CPU instructions (or rather a special `lock` instruction prefix):

```rust
#[no_mangle]
pub fn add_relaxed(n: std::sync::atomic::AtomicU64) -> u64 {
    n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
```

becomes

```asm
add_relaxed:
        mov     qword ptr [rsp - 8], rdi
        mov     eax, 1
        lock            xadd    qword ptr [rsp - 8], rax
        ret
```

Of course it's possible to load and store them as well. However, you might've noticed that there's a special argument called "memory ordering" that needs to be passed. Rust follows C++ memory model which is not the only one but I think it's the most popular model as of now.

The problem with both modern compilers and CPUs (well, in fact, it's a feature) is that they can re-order instructions if they think that it makes the code run faster, but it can also produce a race condition.

The idea is that for each atomic operation that you perform you need to additionally pass a special enum flag that is one of:

### `relaxed`

That's the "weakest" requirement for the CPU. This mode requires no synchronization and allows any kind of re-ordering. It's the fastest type of atomic operation and it's very suitable for things like counters or just reads/writes where order doesn't matter, or when you only care about the final result. This is what we are going to use in the next chapter to implement correct atomic counter.

### `acquire`/`release`

I'm going to quote C++ documentation here:

> A load operation with `acquire` memory order performs the acquire operation on the affected memory location: no reads or writes in the current thread can be reordered before this load. All writes in other threads that release the same atomic variable are visible in the current thread.

> A store operation with `release` memory order performs the release operation: no reads or writes in the current thread can be reordered after this store. All writes in the current thread are visible in other threads that acquire the same atomic variable and writes that carry a dependency into the atomic variable become visible in other threads that consume the same atomic.

If it sounds complicated you are not alone. Here's a nice example from C++:

```cpp
std::atomic<std::string*> ptr;
int data;

void producer()
{
    std::string* p = new std::string("Hello");
    data = 42;
    ptr.store(p, std::memory_order_release);
}

void consumer()
{
    std::string* p2;
    while (!(p2 = ptr.load(std::memory_order_acquire)))
        ;
    assert(*p2 == "Hello"); // never fires
    assert(data == 42); // never fires
}

int main()
{
    std::thread t1(producer);
    std::thread t2(consumer);
    t1.join(); t2.join();
}
```

Here when we call `store(release)` in `producer` it's guaranteed that any other threads that loads the value using `load(acquire)` will see the change to the underlying value (a string) together with other changes made by the writing thread (`int data`).

This synchronization primitive might look unusual to you if you have never seen it before, but the idea is simple: this memory ordering level guarantees that all of your changes made in one thread become visible to other thread in one go.

### `seq_cst`

Stands for "Sequentially Consistent" ordering.

> A load operation with `seq_cst` memory order performs an acquire operation, a store performs a release operation, and read-modify-write performs both an acquire operation and a release operation, plus a single total order exists in which all threads observe all modifications in the same order.

That's the strongest level of "consistency" and also the slowest.

### It all looks similar to transactional databases, right?

Kind of, there's something in common:

| Memory Ordering | Database Isolation Level |
|-----------------|--------------------------|
| Relaxed         | Uncommitted              |
| Acquire/Release | Repeatable Read          |
| Sequential      | Serializable             |

But in my opinion it's better NOT to think of atomics in terms of databases. Levels of memory ordering aim to represent how instructions can/cannot be reordered and what happens-before or happens-after what.
