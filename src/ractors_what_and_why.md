# Ractors, what and why

A bit of history first (I promise, there will be code, a lot, soon). Ruby had threads for a really long time, but they are ... not quite parallel. That's right, `Thread` class in Ruby is a native thread under the hood (POSIX thread on Linux to be more specific, using `pthread_*` and friends) but in order to evaluate any instructions, a thread needs to acquire what's called the `Global Interpreter Lock` (or GIL). The consequence is obvious: only one thread can evaluate code at any point in time.

There has always been one good exception: I/O-related work and only if it's cooked "right". There are C APIs in Ruby that allow you to call your C function (let's say something like `sql_adapter_execute_query`) without acquiring the lock. Then, once the function returns, the lock is acquired again. If this API is used you can do I/O in parallel.

To sum up, in the world of `Thread`s

1. you can do I/O in parallel (like reading files)
2. you can't do CPU-bound computations in parallel (like calculating Fibonacci numbers)

But things changed after Ruby 3.0 was released in 2020, now we have a new building brick called `Ractor`. Ractors are also implemented using threads internally but **each Ractor has its own GIL**. It was a very promising moment of "hey, we can have true multi-threaded parallel apps now!". As always there was a catch.

Ruby objects have no internal synchronization logic, so if Ractor A pushes to an array and so does Ractor B then... nobody knows what's going to happen; it's a race condition. At best, it crashes, at worst one push overwrites the other, and something weird starts happening. Fixing it requires either wrapping every single object with a mutex or forbidding access to the same object from multiple threads. The solution was somewhere in the middle: you can only share objects but **only if they are deeply frozen** (there's a special `Ractor.make_shareable` API specifically for that). And don't get me wrong, I think it's a good compromise.

So now you can do computations in parallel if they don't share any mutable data which sounds like a HUGE limitation for real-world apps. Just from the top of my head, things that I'd like to have:

1. a global queue of requests (main thread accepts incoming connections and pushes them to the queue. Worker threads poll the queue and process requests)
2. a global pool of objects (to store database connections)
3. a global data structure to store metrics
4. a global in-memory cache for things that change rarely but are needed everywhere (e.g. dynamic app configuration)

Calling `require` in a non-main Ractor wasn't possible before the latest version of Ruby (because it mutates shared global variable `$LOADED_FEATURES`), but now it's doable by sending a special message to the main Ractor that does `require`. Remember, the main Ractor can mutate anything; otherwise it would be the biggest breaking change in the history of programming languages, and then it responds back to Ractor that asked for it so that it can continue its execution loop.
