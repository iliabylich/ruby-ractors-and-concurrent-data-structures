# Ractors, what and why

A bit of history first (I promise, there will be code, a lot, soon). Ruby had threads for a really long time, but they are ... not quite parallel. That's right, `Thread` class in Ruby is a native thread under the hood (POSIX thread on Linux to be more specific, using `pthread_*` and friends) but in order to evaluate any instructions, a thread needs to acquire what's called the `Global Interpreter Lock` (or GIL). The consequence is obvious: only one thread can evaluate code at any point in time.

There has always been one good exception: I/O-related work and only if it's cooked "right". There are C APIs in Ruby that allow you to call your C function (let's say something like `sql_adapter_execute_query`) without acquiring the lock. Then, once the function returns, the lock is acquired again. If this API is used you can do I/O in parallel.

To sum up, in the world of `Thread`s

1. you can do I/O in parallel (like reading files)
2. you can't do CPU-bound computations in parallel (like calculating Fibonacci numbers)

But things changed after Ruby 3.0 was released in 2020, now we have a new building brick called `Ractor`. Ractors are also implemented using threads internally but **each Ractor has its own GIL**. It was a very promising moment of "hey, we can have true multi-threaded parallel apps now!". As always there was a catch.

Ruby objects have no internal synchronization logic, so if Ractor A pushes to an array and so does Ractor B then... nobody knows what's going to happen; it's a race condition. At best, it crashes, at worst one push overwrites the other, and something weird starts happening. Fixing it requires wrapping every single object with a mutex or forbidding access to the same object from multiple threads. The solution was somewhere in the middle: you can only share objects but **only if they are deeply frozen** (there's a special `Ractor.make_shareable` API specifically for that). And don't get me wrong, I think it's a good compromise.

So now you can do computations in parallel if they don't share any mutable data which sounds like a HUGE limitation for real-world apps. Just off the top of my head, things that I'd like to have:

1. a global queue of requests (main thread accepts incoming connections and pushes them to the queue. Worker threads poll the queue and process requests.)
2. a global pool of objects (to store database connections)
3. a global data structure to store metrics
4. a global in-memory cache for things that change rarely but are needed everywhere (e.g. dynamic app configuration)

Calling `require` in a non-main Ractor wasn't possible before the latest version of Ruby (because it mutates shared global variable `$LOADED_FEATURES`), but now it's doable by sending a special message to the main Ractor that does `require` and waiting until it's done (remember, the main Ractor can mutate anything; otherwise it would be the biggest breaking change in the history of programming languages), and then it responds back to Ractor that asked for it so that it can continue its execution loop.

# What's wrong with forking

Without truly parallel threads a common option was (and de-facto is) to use `fork`. It works but it comes with its own set of problems:

1. child processes share some memory with their parent, but only if the actual memory hasn't been changed by a child. Any attempt to modify it on the child level makes the OS create a copy of the page that is about to change, copy the content from parent to child, and then apply changes there. In practice it means that if your app does a lot of lazy initialization then most probably you'll not share much memory. **With threads nothing has to be copied**
2. you can't have any shared global state unless you use [shared memory object API](https://man7.org/linux/man-pages/man7/shm_overview.7.html) which is not easy to get right. If you absolutely must track some global progress then you have to introduce some [IPC](https://en.wikipedia.org/wiki/Inter-process_communication) (e.g. via [`socketpair`](https://man7.org/linux/man-pages/man2/socketpair.2.html)) which is not trivial. **With threads everything can be shared and no additional abstraction is needed**

> Not a long time ago there was [a series](https://byroot.github.io/ruby/performance/2025/02/27/whats-the-deal-with-ractors.html) [of interesting articles](https://byroot.github.io/ruby/performance/2025/03/04/the-pitchfork-story.html) that mentioned Ractors in multiple places. One significant thing that I learned from it is that when you `fork` you can't share many internal data structures that are filled by Ruby under the hood. For example, inline method caches that are used to speed up method lookup. These caches depend on your runtime behaviour, and since each child process has its own flow they end up having different caches that are filled differently and in different order. This makes the OS to copy all pages that contain them.

> Side note: do you remember a thing called "REE" (Ruby Enterprise Edition)? It was an "optimized" version of Ruby in pre-2.0 era. One of its key features was "copy-on-write friendly GC" that was about storing bitflags for marked objects not in the object itself but in a separate centralized place. Then, when GC runs, it would only change those "externally" stored bits instead of modifying objects. This way each process only has to copy this table of flags instead of copying the entire heap. By the way, from what I know these patches have been backported to Ruby in 2.0.
